import type { Bindings } from '../../auth.server'
import { digest, Fault, integer, keys, object, text, type ObjectValue } from '../core'
import type { AppliedPolicy } from '../audit/policy'
import { append } from '../audit/store'
import { grantFence, type Grant } from '../authority/store'
import { charge, refund, readPayment } from '../payments/stripe'
import { authorizationHash, authorizationRow, promptUrl, proposeAuthorization } from './authorization'
import { dialAvailability, dialBook } from './dial'
import { exceptionRow, openBlocking, raise } from './exceptions'
import { helpdeskNote } from './helpdesk'
import { orbitHandoff } from './orbit'
import { localTime, type ExceptionKind, type Outcome, type Policy } from './model'
import { say, itemNames, type SayKey } from './say'
import { stepRow, runStep, uuidFrom, type RunResult } from './steps'

export interface Ctx { env: Bindings; grant: Grant; applied: AppliedPolicy; outcome: Outcome; policy: Policy; policyVersion: number }
const freshMs = 600000
const serviceOf = (c: Ctx, serviceId: unknown) => { const s = c.policy.services.find(s => s.id === text(serviceId, 'serviceId', 60)); if (!s) throw new Fault('service_not_in_policy', 403); return s }
const conn = (c: Ctx, needs: ('dial' | 'stripe' | 'orbit' | 'helpdesk')[]) => needs.filter(n => n === 'dial' ? !c.env.HANDSET_DIAL_TOKEN : n === 'stripe' ? !c.env.HANDSET_STRIPE_KEY : n === 'orbit' ? !c.env.HANDSET_ORBIT_TOKEN : !c.env.HANDSET_HELPDESK_TOKEN)
/** A connector that is not installed is an honest held state with an owned escalation, never a pretend success. */
async function heldBy(c: Ctx, step: string, reason: string) {
 const e = await raise(c.env, c.grant, c.applied, c.outcome, c.policy, c.policyVersion, 'provider_failure', { step, reason, state: 'held' }, 'held')
 return { state: 'held', reason, exception: e.exception.id, say: say(c.policy, c.outcome.language, 'held') }
}
async function failure(c: Ctx, r: RunResult, step: string) {
 if (r.step.state === 'confirmed' || step === 'booking' && r.step.state === 'rejected' && /slot|unavailable/.test(r.reason)) return null
 return raise(c.env, c.grant, c.applied, c.outcome, c.policy, c.policyVersion, 'provider_failure', { step, state: r.step.state, reason: r.reason })
}
/** Settle an earlier provider_failure once the same step's readback confirms. */
async function resolveFailures(c: Ctx, step: string) {
 await c.env.DB.prepare("UPDATE hnd_rx_exceptions SET status='resolved',note='Readback later confirmed the step' WHERE outcome_id=? AND kind='provider_failure' AND status='open' AND json_extract(requested,'$.step')=?").bind(c.outcome.id, step).run()
}
const reply = (r: RunResult, key: SayKey, v: Parameters<typeof say>[3], c: Ctx, extra: Record<string, unknown> = {}) => ({ step: { id: r.step.id, kind: r.step.kind, state: r.step.state, externalId: r.step.external_id, attempts: r.step.attempts }, replay: r.replay, reason: r.reason, effectOccurred: r.step.state === 'confirmed' && !r.replay, say: say(c.policy, c.outcome.language, key, v), ...extra })
const guard = async (c: Ctx) => { const b = await openBlocking(c.env.DB, c.outcome.id); if (b) throw new Fault('blocked_by_open_exception', 409, { exceptionId: b.id, kind: b.kind }) }

export async function availability(c: Ctx, value: ObjectValue) {
 keys(value, ['serviceId'])
 const s = serviceOf(c, value.serviceId), missing = conn(c, ['dial'])
 if (missing.length) return heldBy(c, 'availability', 'dial_connector_unconfigured')
 const read = await dialAvailability(c.env, s, c.policy.timezone)
 if (read.state !== 'ok') return { state: read.state, reason: read.reason, slots: [] as string[] }
 const fetchedAt = Date.now(), request = { serviceId: s.id }, hash = await digest(request)
 const existing = await stepRow(c.env.DB, c.outcome.id, 'availability')
 const body = JSON.stringify({ serviceId: s.id, slots: read.slots, fetchedAt })
 await append(c.env, c.grant.id, 'outcome.step', existing?.id ?? crypto.randomUUID(), 'completed', [grantFence(c.env, c.grant),
  existing ? c.env.DB.prepare("UPDATE hnd_rx_steps SET state='confirmed',request=?,request_hash=?,readback=?,version=version+1,updated_at=? WHERE id=?").bind(JSON.stringify(request), hash, body, fetchedAt, existing.id)
   : c.env.DB.prepare("INSERT INTO hnd_rx_steps(id,outcome_id,kind,state,request,request_hash,readback,attempts,version,created_at,updated_at) VALUES (?,?,'availability','confirmed',?,?,?,1,1,?,?)").bind(crypto.randomUUID(), c.outcome.id, JSON.stringify(request), hash, body, fetchedAt, fetchedAt)], null, c.applied)
 return { state: 'ok', serviceId: s.id, slots: read.slots.slice(0, 20).map(startAt => ({ startAt, spoken: localTime(c.policy, c.outcome.language, startAt) })), fetchedAt }
}
export async function knowledge(c: Ctx, value: ObjectValue) {
 keys(value, ['facts'])
 if (!Array.isArray(value.facts) || !value.facts.length || value.facts.length > 50) throw new Fault('invalid_facts')
 const facts = value.facts.map(raw => { const f = object(raw); keys(f, ['topic', 'value', 'sourceId', 'version']); return { topic: text(f.topic, 'topic', 80), value: text(f.value, 'value', 500), sourceId: text(f.sourceId, 'sourceId', 100), version: text(f.version, 'version', 80) } })
 const results: { topic: string; status: string; value?: string; version?: string }[] = [], raised = []
 for (const f of facts) {
  const known = c.policy.knowledge.find(k => k.topic === f.topic), peers = facts.filter(o => o.topic === f.topic && o.value !== f.value)
  if (!known) { results.push({ topic: f.topic, status: 'unknown' }); raised.push(await raise(c.env, c.grant, c.applied, c.outcome, c.policy, c.policyVersion, 'missing_knowledge', { topic: f.topic })); continue }
  if (known.value !== f.value || known.version !== f.version || peers.length) {
   results.push({ topic: f.topic, status: 'conflict' })
   raised.push(await raise(c.env, c.grant, c.applied, c.outcome, c.policy, c.policyVersion, 'knowledge_conflict', { topic: f.topic, claimed: f.value, claimedVersion: f.version, claimedSource: f.sourceId, published: known.value, publishedVersion: known.version }))
  } else results.push({ topic: f.topic, status: 'confirmed', value: known.value, version: known.version })
 }
 await append(c.env, c.grant.id, 'outcome.read', c.outcome.id, 'completed', [grantFence(c.env, c.grant)], null, c.applied)
 return { results, escalated: raised.map(r => r.exception.id), say: raised[0]?.say ?? null }
}
export async function booking(c: Ctx, value: ObjectValue) {
 keys(value, ['serviceId', 'startAt'])
 const s = serviceOf(c, value.serviceId), startAt = text(value.startAt, 'startAt', 40)
 if (Number.isNaN(Date.parse(startAt))) throw new Fault('invalid_startAt')
 const start = new Date(Date.parse(startAt)).toISOString()
 if (!c.outcome.identity_reported) throw new Fault('identity_verification_required', 403)
 await guard(c)
 const read = await stepRow(c.env.DB, c.outcome.id, 'availability'), snapshot = read?.readback ? JSON.parse(read.readback) as { serviceId: string; slots: string[]; fetchedAt: number } : null
 if (!snapshot || snapshot.serviceId !== s.id || Date.now() - snapshot.fetchedAt > freshMs || !snapshot.slots.includes(start)) throw new Fault('fresh_availability_read_required', 409)
 if (conn(c, ['dial']).length) return heldBy(c, 'booking', 'dial_connector_unconfigured')
 const r = await runStep({ env: c.env, grant: c.grant, applied: c.applied, outcome: c.outcome, kind: 'booking', request: { serviceId: s.id, startAt: start },
  execute: async (key, known, beforeEffect) => dialBook(c.env, { idempotencyKey: uuidFrom(await digest(key)), eventTypeId: s.eventTypeId, startAt: start, inviteeTimezone: c.policy.timezone, name: c.outcome.caller_name, email: c.outcome.caller_email, answers: { handsetCall: c.outcome.call_id }, durationMinutes: s.minutes }, known, beforeEffect) })
 const exception = await failure(c, r, 'booking'); if (r.step.state === 'confirmed') await resolveFailures(c, 'booking')
 return reply(r, r.step.state === 'confirmed' ? 'booking_confirmed' : r.step.state === 'rejected' ? 'booking_rejected' : 'booking_pending', { when: localTime(c.policy, c.outcome.language, start) }, c, { exceptionId: exception?.exception.id ?? null })
}

export async function proposeDeposit(c: Ctx, value: ObjectValue) {
 keys(value, ['serviceId', 'amountCents', 'discountExceptionId'])
 const s = serviceOf(c, value.serviceId), amount = integer(value.amountCents, 'amountCents', 1, 1000000)
 await guard(c)
 const book = await stepRow(c.env.DB, c.outcome.id, 'booking')
 if (!book || book.state !== 'confirmed' || (JSON.parse(book.request) as { serviceId: string }).serviceId !== s.id) throw new Fault('confirmed_booking_required', 409)
 if (amount > s.depositCents || amount > c.policy.maxDepositCents) { await append(c.env, c.grant.id, 'outcome.authorize', crypto.randomUUID(), 'refused', [grantFence(c.env, c.grant)], null, c.applied); throw new Fault('amount_exceeds_policy', 403) }
 const discount = s.depositCents - amount
 if (discount > c.policy.maxDiscountCents) {
  const approved = value.discountExceptionId ? await exceptionRow(c.env.DB, text(value.discountExceptionId, 'discountExceptionId')) : null
  const requested = approved ? JSON.parse(approved.requested) as { discountCents: number } : null
  if (!approved || approved.outcome_id !== c.outcome.id || approved.kind !== 'out_of_policy_discount' || approved.status !== 'approved' || requested!.discountCents !== discount) {
   const e = await raise(c.env, c.grant, c.applied, c.outcome, c.policy, c.policyVersion, 'out_of_policy_discount', { serviceId: s.id, listCents: s.depositCents, discountCents: discount, amountCents: amount })
   return { state: 'escalated', exceptionId: e.exception.id, effectOccurred: false, say: e.say }
  }
 }
 const a = await proposeAuthorization(c.env, grantFence(c.env, c.grant), c.grant.id, c.applied, c.outcome, c.policy.businessName, amount, s.name)
 return { state: 'awaiting_caller', authorizationId: a.id, amountCents: a.amount_cents, payee: a.payee, purpose: a.purpose, prompt: { language: a.language, text: a.prompt }, carrierPromptUrl: promptUrl(c.env, a.id), effectOccurred: false }
}
export async function deposit(c: Ctx, value: ObjectValue) {
 keys(value, ['authorizationId'])
 const a = await authorizationRow(c.env.DB, text(value.authorizationId, 'authorizationId'))
 if (!a || a.outcome_id !== c.outcome.id) throw new Fault('authorization_not_found', 404)
 await guard(c)
 const existing = await stepRow(c.env.DB, c.outcome.id, 'deposit')
 if (a.state !== 'authorized') throw new Fault(a.state === 'declined' ? 'caller_declined_charge' : 'caller_authorization_required', 403)
 if (a.prompt_hash !== await authorizationHash(a)) throw new Fault('authorization_changed', 409)
 if (!existing && (a.decided_at ?? 0) + 1800000 <= Date.now()) throw new Fault('caller_authorization_expired', 409)
 if (existing && existing.amount_cents !== a.amount_cents) throw new Fault('step_request_changed', 409)
 const book = await stepRow(c.env.DB, c.outcome.id, 'booking')
 if (!book || book.state !== 'confirmed') throw new Fault('confirmed_booking_required', 409)
 if (!c.outcome.payment_method_ref) throw new Fault('payment_method_reference_required', 409)
 if (conn(c, ['stripe']).length) return heldBy(c, 'deposit', 'stripe_connector_unconfigured')
 const d = JSON.parse(c.grant.definition) as { budgetCents: number }, methodRef = c.outcome.payment_method_ref
 const r = await runStep({ env: c.env, grant: c.grant, applied: c.applied, outcome: c.outcome, kind: 'deposit', request: { authorizationId: a.id, amountCents: a.amount_cents }, amountCents: a.amount_cents,
  effect: stepId => [c.env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rx_authorizations WHERE id=? AND state='authorized' AND consumed_by=? AND expires_at>?").bind(a.id, stepId, Date.now())],
  claim: stepId => [
   c.env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_grants WHERE id=? AND revision=? AND reserved_cents+?<=?').bind(c.grant.id, c.grant.revision, a.amount_cents, d.budgetCents),
   c.env.DB.prepare('UPDATE hnd_grants SET reserved_cents=reserved_cents+? WHERE id=?').bind(a.amount_cents, c.grant.id),
   c.env.DB.prepare('UPDATE hnd_rx_authorizations SET consumed_by=? WHERE id=? AND (consumed_by IS NULL OR consumed_by=?)').bind(stepId, a.id, stepId),
   c.env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rx_authorizations WHERE id=? AND consumed_by=?').bind(a.id, stepId),
  ],
  release: [c.env.DB.prepare('UPDATE hnd_grants SET reserved_cents=MAX(reserved_cents-?,0) WHERE id=?').bind(a.amount_cents, c.grant.id)],
  execute: (key, known, beforeEffect) => {
   const input = { outcomeId: c.outcome.id, amountCents: a.amount_cents, paymentMethod: methodRef, description: `${a.payee}: ${a.purpose}`, key }
   return known ? readPayment(c.env, known, input) : charge(c.env, input, beforeEffect)
  } })
 const exception = await failure(c, r, 'deposit'); if (r.step.state === 'confirmed') await resolveFailures(c, 'deposit')
 return reply(r, r.step.state === 'confirmed' ? 'deposit_confirmed' : r.step.state === 'rejected' ? 'deposit_failed' : 'deposit_pending', { amount: a.amount_cents }, c, { exceptionId: exception?.exception.id ?? null })
}
async function summary(c: Ctx, value: ObjectValue) {
 const note = text(value.summary ?? '', 'summary', 1000, true), book = await stepRow(c.env.DB, c.outcome.id, 'booking'), dep = await stepRow(c.env.DB, c.outcome.id, 'deposit')
 const line = (label: string, s: typeof book) => `${label} ${s ? s.state + (s.external_id ? ' ' + s.external_id : '') : 'not attempted'}`
 return `Handset call ${c.outcome.call_id} (${c.outcome.language}${c.outcome.after_hours ? ', after hours' : ''}) case ${c.outcome.case_id} outcome ${c.outcome.id}: ${line('booking', book)}; ${line('deposit', dep)}.${note ? ' Caller context (unverified): ' + note : ''}`
}
export async function crmHandoff(c: Ctx, value: ObjectValue, stored?: string) {
 keys(value, ['summary'])
 if (!c.policy.orbitTarget) return heldBy(c, 'crm', 'orbit_target_unselected')
 if (conn(c, ['orbit']).length) return heldBy(c, 'crm', 'orbit_connector_unconfigured')
 const content = stored ?? await summary(c, value)
 const r = await runStep({ env: c.env, grant: c.grant, applied: c.applied, outcome: c.outcome, kind: 'crm', request: { target: c.policy.orbitTarget, content },
  execute: (_key, _known, beforeEffect) => orbitHandoff(c.env, c.policy.orbitTarget, `handset-${c.outcome.id}-crm`, content, beforeEffect) })
 const exception = await failure(c, r, 'crm'); if (r.step.state === 'confirmed') await resolveFailures(c, 'crm')
 return reply(r, r.step.state === 'confirmed' ? 'handoff_done' : 'handoff_pending', { item: itemNames[c.outcome.language].crm }, c, { exceptionId: exception?.exception.id ?? null })
}
export async function supportHandoff(c: Ctx, value: ObjectValue, stored?: string) {
 keys(value, ['summary', 'conversationId'])
 const conversationId = text(value.conversationId, 'conversationId', 100)
 if (conn(c, ['helpdesk']).length) return heldBy(c, 'support', 'helpdesk_connector_unconfigured')
 const content = stored ?? await summary(c, value)
 const r = await runStep({ env: c.env, grant: c.grant, applied: c.applied, outcome: c.outcome, kind: 'support', request: { conversationId, content },
  execute: (_key, _known, beforeEffect) => helpdeskNote(c.env, conversationId, `handset-${c.outcome.id}-support`, content, beforeEffect) })
 const exception = await failure(c, r, 'support'); if (r.step.state === 'confirmed') await resolveFailures(c, 'support')
 return reply(r, r.step.state === 'confirmed' ? 'handoff_done' : 'handoff_pending', { item: itemNames[c.outcome.language].support }, c, { exceptionId: exception?.exception.id ?? null })
}
const exceptionKindsAgentMay: ExceptionKind[] = ['out_of_policy_refund', 'emergency_dispatch', 'human_request']
export async function escalate(c: Ctx, value: ObjectValue) {
 keys(value, ['kind', 'amountCents', 'detail'])
 const kind = text(value.kind, 'kind', 40) as ExceptionKind
 if (!exceptionKindsAgentMay.includes(kind)) throw new Fault('invalid_kind')
 const detail = text(value.detail ?? '', 'detail', 1000, true)
 let requested: Record<string, unknown> = { detail }
 if (kind === 'out_of_policy_refund') {
  const dep = await stepRow(c.env.DB, c.outcome.id, 'deposit'), amount = integer(value.amountCents, 'amountCents', 1, 1000000)
  if (!dep || dep.state !== 'confirmed' || !dep.external_id) throw new Fault('confirmed_deposit_required', 409)
  if (amount > dep.amount_cents) throw new Fault('refund_exceeds_deposit', 403)
  if (amount <= c.policy.maxRefundCents) throw new Fault('refund_within_policy_use_refund_door', 409)
  requested = { amountCents: amount, paymentIntent: dep.external_id, detail }
 } else if (kind === 'emergency_dispatch') requested = { detail }
 const e = await raise(c.env, c.grant, c.applied, c.outcome, c.policy, c.policyVersion, kind, requested)
 return { state: 'escalated', exceptionId: e.exception.id, replay: e.replay, callbackDueAt: e.exception.callback_due_at, notification: e.exception.notification, effectOccurred: false, say: e.say }
}
export async function refundDeposit(c: Ctx, value: ObjectValue) {
 keys(value, ['exceptionId'])
 const e = await exceptionRow(c.env.DB, text(value.exceptionId, 'exceptionId'))
 if (!e || e.outcome_id !== c.outcome.id || e.kind !== 'out_of_policy_refund') throw new Fault('exception_not_found', 404)
 if (e.status !== 'approved') throw new Fault('named_person_approval_required', 403)
 const dep = await stepRow(c.env.DB, c.outcome.id, 'deposit'), requested = JSON.parse(e.requested) as { amountCents: number; paymentIntent: string }
 if (!dep || dep.state !== 'confirmed' || dep.external_id !== requested.paymentIntent || requested.amountCents > dep.amount_cents) throw new Fault('confirmed_deposit_required', 409)
 if (conn(c, ['stripe']).length) return heldBy(c, 'refund', 'stripe_connector_unconfigured')
 const r = await runStep({ env: c.env, grant: c.grant, applied: c.applied, outcome: c.outcome, kind: 'refund', request: { exceptionId: e.id, amountCents: requested.amountCents, paymentIntent: requested.paymentIntent }, amountCents: requested.amountCents,
  claim: stepId => [c.env.DB.prepare("UPDATE hnd_rx_exceptions SET consumed_by=? WHERE id=? AND status='approved' AND (consumed_by IS NULL OR consumed_by=?)").bind(stepId, e.id, stepId), c.env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rx_exceptions WHERE id=? AND consumed_by=?').bind(e.id, stepId)],
  effect: () => [c.env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rx_exceptions e JOIN oa_operators o ON o.id=e.decided_by WHERE e.id=? AND e.status='approved' AND o.status='active' AND o.role='owner' AND o.version=e.decided_owner_version").bind(e.id)],
  execute: (key, _known, beforeEffect) => refund(c.env, { outcomeId: c.outcome.id, paymentIntent: requested.paymentIntent, amountCents: requested.amountCents, key }, beforeEffect) })
 const exception = await failure(c, r, 'refund'); if (r.step.state === 'confirmed') await resolveFailures(c, 'refund')
 return reply(r, r.step.state === 'confirmed' ? 'refund_confirmed' : 'deposit_pending', { amount: requested.amountCents }, c, { exceptionId: exception?.exception.id ?? null })
}
export async function reconcile(c: Ctx, value: ObjectValue) {
 keys(value, ['step'])
 const kind = text(value.step, 'step', 20)
 const step = ['booking', 'deposit', 'crm', 'support', 'refund'].includes(kind) ? await stepRow(c.env.DB, c.outcome.id, kind as 'booking') : null
 if (!step) throw new Fault('step_not_found', 404)
 if (!['sent', 'uncertain', 'held'].includes(step.state)) return { step: { id: step.id, kind: step.kind, state: step.state, externalId: step.external_id }, replay: true, effectOccurred: false, reason: 'nothing_to_reconcile' }
 const request = JSON.parse(step.request) as Record<string, string>
 if (kind === 'booking') return booking(c, { serviceId: request.serviceId, startAt: request.startAt })
 if (kind === 'deposit') return deposit(c, { authorizationId: request.authorizationId })
 if (kind === 'refund') return refundDeposit(c, { exceptionId: request.exceptionId })
 if (kind === 'crm') return crmHandoff(c, {}, request.content)
 return supportHandoff(c, { conversationId: request.conversationId }, request.content)
}
