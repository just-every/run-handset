import type { Bindings } from '../../auth.server'
import { digest, Fault, id } from '../core'
import { append } from '../audit/store'
import type { AppliedPolicy } from '../audit/policy'
import { grantFence, type Grant } from '../authority/store'
import type { EdgeResult } from './edge'
import type { Outcome, Step, StepKind } from './model'
import { deliveryScopeFence } from '../integrations/delivery/scope'

export const uuidFrom = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
export const stepRow = (db: D1Database, outcomeId: string, kind: StepKind) => db.prepare('SELECT * FROM hnd_rx_steps WHERE outcome_id=? AND kind=?').bind(outcomeId, kind).first<Step>()
const auditOutcome = (state: string) => state === 'confirmed' ? 'completed' : state === 'uncertain' ? 'uncertain' : 'refused'
export interface Run {
 env: Bindings; grant: Grant; applied: AppliedPolicy; outcome: Outcome; kind: StepKind; request: unknown; amountCents?: number
 /** Statements that must commit with the first claim only (budget reservation, authorization consumption). */
 claim?: (stepId: string) => D1PreparedStatement[]
 /** Statements that must commit with a rejected final answer (budget release). */
 release?: D1PreparedStatement[]
 /** `key` is stable for this exact request; `known` is a receiving-system identifier already learned. */
 execute: (key: string, known: string | null, beforeEffect: () => Promise<void>) => Promise<EdgeResult>
 effect?: (stepId: string) => D1PreparedStatement[]
}
export interface RunResult { step: Step; replay: boolean; reason: string }
/** One durable step per receiving system. The step is marked `sent` before any network effect, the same
 * idempotency key is reused on every retry and the caller is only told what a readback confirmed. */
export function outcomeEffectFences(env: Bindings, outcome: Outcome): D1PreparedStatement[] {
 return [env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rx_outcomes o JOIN hnd_cases c ON c.id=o.case_id
 WHERE o.id=? AND o.case_version=c.version AND o.case_version>0 AND o.policy_version=(SELECT max(version) FROM hnd_rx_policy)`)
 .bind(outcome.id), env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT CASE WHEN EXISTS(
 SELECT 1 FROM hnd_protection_stops s JOIN hnd_records r ON r.case_id=?
 WHERE s.recipient IN (json_extract(r.data,'$.from'),json_extract(r.data,'$.to'))) THEN 0 ELSE 1 END`).bind(outcome.case_id)]
}
export async function runStep(r: Run): Promise<RunResult> {
 const { env, grant, outcome, kind } = r, db = env.DB, hash = await digest(r.request), now = Date.now()
 let step = await stepRow(db, outcome.id, kind)
 if (step && step.state === 'confirmed') {
  if (step.request_hash !== hash) throw new Fault('step_request_changed', 409)
  await append(env, grant.id, 'outcome.read', step.id, 'completed', [grantFence(env, grant)], null, r.applied)
  return { step, replay: true, reason: 'already_confirmed' }
 }
 if (step && step.state === 'rejected' && step.request_hash === hash) return { step, replay: true, reason: step.reason }
 if (step && !['rejected'].includes(step.state) && step.request_hash !== hash) throw new Fault('step_request_changed', 409)
 const previouslyUncertain = Boolean(step && ['sent', 'uncertain'].includes(step.state))
 const key = `${outcome.id}:${kind}:${hash}`
 if (!step) {
  const stepId = id()
  try {
   await append(env, grant.id, 'outcome.step', stepId, 'uncertain', [
    grantFence(env, grant), ...outcomeEffectFences(env, outcome), ...(r.claim?.(stepId) ?? []),
    db.prepare("INSERT INTO hnd_rx_steps(id,outcome_id,kind,state,request,request_hash,external_id,readback,attempts,amount_cents,version,created_at,updated_at,reason) VALUES (?,?,?,'sent',?,?,NULL,NULL,1,?,1,?,?,'effect_claimed_readback_required')").bind(stepId, outcome.id, kind, JSON.stringify(r.request), hash, r.amountCents ?? 0, now, now),
   ], null, r.applied)
  } catch (error) {
   if (String(error).includes('UNIQUE constraint failed: hnd_rx_steps')) throw new Fault('step_conflict_retry_same_request', 409)
   throw error
  }
  step = (await stepRow(db, outcome.id, kind))!
 } else {
  // Claim the retry: a concurrent caller loses the version check instead of sending a second effect.
  await append(env, grant.id, 'outcome.step', step.id, 'uncertain', [
   grantFence(env, grant), ...outcomeEffectFences(env, outcome), db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rx_steps WHERE id=? AND version=?').bind(step.id, step.version),
   db.prepare("UPDATE hnd_rx_steps SET state='sent',request=?,request_hash=?,attempts=attempts+1,version=version+1,updated_at=? WHERE id=? AND version=?").bind(JSON.stringify(r.request), hash, now, step.id, step.version),
   ...(step.state === 'rejected' ? (r.claim?.(step.id) ?? []) : []),
  ], null, r.applied)
  step = (await stepRow(db, outcome.id, kind))!
 }
 let result: EdgeResult
 const beforeEffect = async () => {
  // Stripe may prune idempotency keys after 24 hours. Keep a one-hour safety margin.
  if (['deposit','refund'].includes(kind) && step!.attempts > 1 && Date.now() - step!.created_at >= 23 * 3600000) throw new Fault('provider_deduplication_window_expired_readback_required', 409)
  const request = r.request as Record<string, string>, connector = kind === 'booking' ? 'dial' : kind === 'crm' ? 'orbit' : kind === 'support' ? 'helpdesk' : 'stripe'
  const target = kind === 'booking' ? request.serviceId : kind === 'crm' ? request.target : kind === 'support' ? request.conversationId : kind
  await append(env, grant.id, 'outcome.authorize', step!.id, 'completed', [grantFence(env, grant), ...outcomeEffectFences(env, outcome), deliveryScopeFence(env, connector, target),
   db.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_grants WHERE id=? AND reserved_cents<=json_extract(definition,'$.budgetCents')").bind(grant.id), ...(r.effect?.(step!.id) ?? []),
  ], null, r.applied)
 }
 try { result = await r.execute(key, step.external_id, beforeEffect) } catch { result = { state: 'uncertain', reason: 'edge_failed_after_send' } }
 // A later authorization failure cannot prove that an earlier lost write failed.
 // Retain the original reservation and permit only reconciliation of the same request.
 if (previouslyUncertain && ['held', 'rejected'].includes(result.state)) result = { ...result, state: 'uncertain' }
 const release = result.state === 'rejected' ? (r.release ?? []) : []
 await append(env, grant.id, 'outcome.step', step.id, auditOutcome(result.state), [
  grantFence(env, grant), db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rx_steps WHERE id=? AND version=?').bind(step.id, step.version),
  db.prepare('UPDATE hnd_rx_steps SET state=?,reason=?,external_id=COALESCE(?,external_id),readback=COALESCE(?,readback),version=version+1,updated_at=? WHERE id=? AND version=?').bind(result.state, result.reason, result.externalId ?? null, result.readback === undefined ? null : JSON.stringify(result.readback), Date.now(), step.id, step.version),
  ...release,
 ], null, r.applied)
 return { step: (await stepRow(db, outcome.id, kind))!, replay: false, reason: result.reason }
}
