import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, id, integer, keys, text, type ObjectValue } from '../core'
import { append, commit } from '../audit/store'
import type { AppliedPolicy } from '../audit/policy'
import { grantFence, type Grant } from '../authority/store'
import type { Definition } from '../authority/model'
import { afterHours, openInput, policy as parsePolicy, type Authorization, type ExceptionRow, type Outcome, type Policy, type PolicyRow, type Step } from './model'

export async function currentPolicy(db: D1Database): Promise<{ version: number; policy: Policy; row: PolicyRow } | null> {
 const row = await db.prepare('SELECT * FROM hnd_rx_policy ORDER BY version DESC LIMIT 1').first<PolicyRow>()
 return row ? { version: row.version, policy: JSON.parse(row.body) as Policy, row } : null
}
export async function policyHistory(db: D1Database) {
 return (await db.prepare('SELECT version,body,owner_id,owner_version,created_at FROM hnd_rx_policy ORDER BY version DESC LIMIT 50').all<PolicyRow>()).results
}
/** The named person sets service, payment and discount limits. Versions are append-only; the exception
 * approver must be an active owner (deny-by-default until ct widens approver roles). */
export async function writePolicy(env: Bindings, actor: Session, value: ObjectValue) {
 keys(value, ['policy', 'expectedVersion', 'confirm'])
 if (value.confirm !== 'set receptionist limits') throw new Fault('explicit_policy_confirmation_required')
 const p = parsePolicy(value.policy), current = await currentPolicy(env.DB), expected = integer(value.expectedVersion, 'expectedVersion', 0)
 if ((current?.version ?? 0) !== expected) throw new Fault('policy_version_conflict', 409, { currentVersion: current?.version ?? 0 })
 if (!await env.DB.prepare("SELECT id FROM oa_operators WHERE id=? AND status='active' AND role='owner'").bind(p.exceptionOwnerId).first()) throw new Fault('named_person_must_be_active_owner')
 const version = expected + 1
 await commit(env, actor, 'outcome.policy', id(), 'completed', [
  env.DB.prepare('INSERT INTO hnd_rx_policy(version,body,owner_id,owner_version,created_at) VALUES (?,?,?,?,?)').bind(version, JSON.stringify(p), actor.operator.id, actor.operator.version, Date.now()),
 ])
 return { version, policy: p }
}
/** The receptionist works under one grant: its work identity. The grant must name outcome work and the call's case. */
export function scoped(g: Grant, caseId: string) {
 const d = JSON.parse(g.definition) as Definition
 if (!d.tools.includes('outcome.work') || !d.scopes.includes('send')) throw new Fault('tool_out_of_scope', 403)
 if (!d.records.includes(caseId)) throw new Fault('record_out_of_scope', 403)
 return d
}
export async function loadOutcome(env: Bindings, g: Grant, outcomeId: string) {
 const outcome = await env.DB.prepare('SELECT * FROM hnd_rx_outcomes WHERE id=? AND grant_id=?').bind(text(outcomeId, 'outcomeId'), g.id).first<Outcome>()
 if (!outcome) throw new Fault('outcome_not_found', 404)
 scoped(g, outcome.case_id)
 const current = await currentPolicy(env.DB)
 const pinned = await env.DB.prepare('SELECT * FROM hnd_rx_policy WHERE version=?').bind(outcome.policy_version).first<PolicyRow>()
 return { outcome, policy: JSON.parse(pinned!.body) as Policy, policyVersion: outcome.policy_version, latest: current }
}
export async function openOutcome(env: Bindings, g: Grant, value: ObjectValue, applied: AppliedPolicy) {
 const v = openInput(value), current = await currentPolicy(env.DB)
 if (!current) throw new Fault('receptionist_policy_required', 409)
 scoped(g, v.caseId)
 if (!await env.DB.prepare('SELECT id FROM hnd_cases WHERE id=?').bind(v.caseId).first()) throw new Fault('case_not_found', 404)
 const existing = await env.DB.prepare('SELECT * FROM hnd_rx_outcomes WHERE grant_id=? AND call_id=?').bind(g.id, v.callId).first<Outcome>()
 if (existing) {
  if (existing.case_id !== v.caseId || existing.language !== v.language || existing.caller_email !== v.callerEmail) throw new Fault('call_already_open_with_other_facts', 409)
  return { outcome: existing, replay: true }
 }
 const outcomeId = id(), now = Date.now()
 await append(env, g.id, 'outcome.open', outcomeId, 'completed', [
  grantFence(env, g),
  env.DB.prepare('INSERT INTO hnd_rx_outcomes(id,grant_id,case_id,call_id,language,after_hours,policy_version,caller_name,caller_email,identity_basis,identity_reported,payment_method_ref,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .bind(outcomeId, g.id, v.caseId, v.callId, v.language, afterHours(current.policy, now), current.version, v.callerName, v.callerEmail, v.identityBasis, v.identityVerified ? 1 : 0, v.paymentMethodRef, now),
 ], null, applied)
 return { outcome: (await env.DB.prepare('SELECT * FROM hnd_rx_outcomes WHERE id=?').bind(outcomeId).first<Outcome>())!, replay: false }
}
const parse = (value: string | null) => value ? JSON.parse(value) : null
export async function readOutcome(db: D1Database, outcome: Outcome) {
 const [steps, exceptions, authorizations] = await Promise.all([
  db.prepare('SELECT * FROM hnd_rx_steps WHERE outcome_id=? ORDER BY created_at,id').bind(outcome.id).all<Step>(),
  db.prepare('SELECT * FROM hnd_rx_exceptions WHERE outcome_id=? ORDER BY created_at,id').bind(outcome.id).all<ExceptionRow>(),
  db.prepare('SELECT * FROM hnd_rx_authorizations WHERE outcome_id=? ORDER BY created_at,id').bind(outcome.id).all<Authorization>(),
 ])
 const { payment_method_ref, caller_email, ...safe } = outcome
 return { outcome: { ...safe, callerEmail: caller_email, paymentMethodOnFile: !!payment_method_ref },
  steps: steps.results.map(s => ({ id: s.id, kind: s.kind, state: s.state, externalId: s.external_id, attempts: s.attempts, amountCents: s.amount_cents, request: parse(s.request), readback: parse(s.readback), updatedAt: s.updated_at })),
  exceptions: exceptions.results.map(e => ({ id: e.id, kind: e.kind, status: e.status, requested: parse(e.requested), ownerId: e.owner_id, callbackDueAt: e.callback_due_at, notification: e.notification, note: e.note, decidedAt: e.decided_at })),
  authorizations: authorizations.results.map(a => ({ id: a.id, amountCents: a.amount_cents, payee: a.payee, purpose: a.purpose, state: a.state, expiresAt: a.expires_at, consumed: !!a.consumed_by })) }
}
