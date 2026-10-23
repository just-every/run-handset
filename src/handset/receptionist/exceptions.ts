import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { operatorMail } from '../../mail.server.mjs'
import { digest, escape, Fault, id, keys, object, text } from '../core'
import { append, commit } from '../audit/store'
import type { AppliedPolicy } from '../audit/policy'
import { grantFence, type Grant } from '../authority/store'
import type { ExceptionKind, ExceptionRow, Outcome, Policy, Step } from './model'
import { dollars } from './model'
import { say, type SayKey } from './say'

export const exceptionRow = (db: D1Database, exceptionId: string) => db.prepare('SELECT * FROM hnd_rx_exceptions WHERE id=?').bind(exceptionId).first<ExceptionRow>()
export const openBlocking = (db: D1Database, outcomeId: string) => db.prepare("SELECT id,kind FROM hnd_rx_exceptions WHERE outcome_id=? AND status='open' AND kind IN ('knowledge_conflict','missing_knowledge')").bind(outcomeId).first<{ id: string; kind: string }>()
async function evidence(env: Bindings, outcome: Outcome, p: Policy, policyVersion: number) {
 const steps = (await env.DB.prepare('SELECT kind,state,external_id,attempts,readback,amount_cents,updated_at FROM hnd_rx_steps WHERE outcome_id=? ORDER BY created_at').bind(outcome.id).all<Step>()).results
 const authorizations = (await env.DB.prepare('SELECT id,amount_cents,payee,purpose,state,expires_at FROM hnd_rx_authorizations WHERE outcome_id=? ORDER BY created_at').bind(outcome.id).all()).results
 return { outcomeId: outcome.id, caseId: outcome.case_id, callId: outcome.call_id, language: outcome.language, afterHours: !!outcome.after_hours, policyVersion, business: p.businessName,
  caller: { name: outcome.caller_name, email: outcome.caller_email, identityBasis: outcome.identity_basis, identityReportedByAgent: !!outcome.identity_reported },
  steps: steps.map(s => ({ kind: s.kind, state: s.state, externalId: s.external_id, attempts: s.attempts, amountCents: s.amount_cents, readback: s.readback ? JSON.parse(s.readback) : null })), authorizations }
}
const labels: Record<ExceptionKind, string> = { out_of_policy_refund: 'Out-of-policy refund', out_of_policy_discount: 'Out-of-policy discount', emergency_dispatch: 'Emergency dispatch request', knowledge_conflict: 'Conflicting knowledge', human_request: 'Caller asked for a person', missing_knowledge: 'Missing knowledge', provider_failure: 'Failed provider action' }
function describe(kind: ExceptionKind, requested: Record<string, unknown>) {
 if (kind === 'out_of_policy_refund') return `Refund of ${dollars(Number(requested.amountCents))} on payment ${String(requested.paymentIntent)}`
 if (kind === 'out_of_policy_discount') return `Discount of ${dollars(Number(requested.discountCents))} on a ${dollars(Number(requested.listCents))} deposit`
 return JSON.stringify(requested)
}
/** Raise one owned escalation per exact request. A repeat of the same request returns the same item, with no second notice. */
export async function raise(env: Bindings, grant: Grant, applied: AppliedPolicy, outcome: Outcome, p: Policy, policyVersion: number, kind: ExceptionKind, requested: Record<string, unknown>, key: SayKey = 'escalated') {
 const hash = await digest({ kind, requested }), db = env.DB
 let row = await db.prepare('SELECT * FROM hnd_rx_exceptions WHERE outcome_id=? AND kind=? AND request_hash=?').bind(outcome.id, kind, hash).first<ExceptionRow>(), replay = !!row
 const now = Date.now(), due = now + p.callbackMinutes * 60000
 if (!row) {
  const exceptionId = id(), owner = await db.prepare("SELECT email FROM oa_operators WHERE id=? AND status='active' AND role='owner'").bind(p.exceptionOwnerId).first<{ email: string }>()
  if (!owner) throw new Fault('named_person_inactive', 409)
  await append(env, grant.id, 'outcome.escalate', exceptionId, 'completed', [
   grantFence(env, grant),
   db.prepare("INSERT INTO hnd_rx_exceptions(id,outcome_id,kind,requested,request_hash,evidence,owner_id,status,callback_due_at,notification,created_at) VALUES (?,?,?,?,?,?,?,'open',?,'uncertain',?)")
    .bind(exceptionId, outcome.id, kind, JSON.stringify(requested), hash, JSON.stringify(await evidence(env, outcome, p, policyVersion)), p.exceptionOwnerId, due, now),
  ], null, applied)
  row = (await exceptionRow(db, exceptionId))!
  const link = `${env.AUTH_ORIGIN}/app/receptionist#exception-${row.id}`
  const body = `${labels[kind]}\n\nExact request: ${describe(kind, requested)}\nCall: ${outcome.call_id} (${outcome.language === 'es' ? 'Spanish' : 'English'}${outcome.after_hours ? ', after hours' : ''})\nCaller: ${outcome.caller_name} <${outcome.caller_email}>\nCallback promised by: ${new Date(due).toISOString()}\n\nEvidence:\n${row.evidence}\n\nReview and decide: ${link}\nNothing has been approved, refunded or dispatched.`
  let state = 'uncertain'
  try {
   const sender = operatorMail(env)
   if (!sender || !env.MAIL_FROM) state = 'failed'
   else { const sent = await sender.send({ deliveryId: row.id, from: env.MAIL_FROM, to: [owner.email], subject: `Handset exception: ${labels[kind]}`, text: body, html: `<pre>${escape(body)}</pre>`, headers: {} }); state = sent.status === 'accepted' || sent.status === 'development' ? 'sent' : sent.status === 'uncertain' ? 'uncertain' : 'failed' }
  } catch (error) { state = error instanceof Error && error.name === 'MailValidationError' ? 'failed' : 'uncertain' }
  await append(env, grant.id, 'outcome.escalate', row.id, state === 'sent' ? 'completed' : state === 'failed' ? 'failed' : 'uncertain', [db.prepare("UPDATE hnd_rx_exceptions SET notification=? WHERE id=? AND notification='uncertain'").bind(state, row.id)], null, applied)
  row = (await exceptionRow(db, row.id))!
 }
 return { exception: row, replay, say: say(p, outcome.language, kind === 'emergency_dispatch' ? 'emergency' : key, { callbackAt: row.callback_due_at }) }
}
export async function decide(env: Bindings, actor: Session, exceptionId: string, value: unknown) {
 const v = object(value); keys(v, ['decision', 'note', 'confirm'])
 if (v.confirm !== 'decide exact exception') throw new Fault('explicit_exception_decision_required')
 const decision = text(v.decision, 'decision', 10)
 if (!['approve', 'decline'].includes(decision)) throw new Fault('invalid_decision')
 const note = text(v.note ?? '', 'note', 1000, true), row = await exceptionRow(env.DB, exceptionId)
 if (!row) throw new Fault('exception_not_found', 404)
 if (row.owner_id !== actor.operator.id) throw new Fault('named_person_required', 403)
 if (row.status !== 'open') throw new Fault('exception_already_decided', 409)
 const status = decision === 'approve' ? 'approved' : 'declined'
 await commit(env, actor, 'outcome.decide', row.id, 'completed', [
  env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rx_exceptions WHERE id=? AND status='open' AND owner_id=?").bind(row.id, actor.operator.id),
  env.DB.prepare("UPDATE hnd_rx_exceptions SET status=?,decided_by=?,decided_owner_version=?,decided_at=?,note=? WHERE id=? AND status='open'").bind(status, actor.operator.id, actor.operator.version, Date.now(), note, row.id),
 ])
 return exceptionRow(env.DB, row.id)
}
