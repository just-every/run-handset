import { choice, Fault, integer, keys, object, text, type ObjectValue } from '../core'

export const languages = ['en', 'es'] as const
export type Language = typeof languages[number]
export const stepKinds = ['availability', 'booking', 'deposit', 'crm', 'support', 'refund'] as const
export type StepKind = typeof stepKinds[number]
export const exceptionKinds = ['out_of_policy_refund', 'out_of_policy_discount', 'emergency_dispatch', 'knowledge_conflict', 'human_request', 'missing_knowledge', 'provider_failure'] as const
export type ExceptionKind = typeof exceptionKinds[number]
export interface Service { id: string; name: string; eventTypeId: string; bookingPage: string; minutes: number; depositCents: number }
export interface Policy {
 businessName: string; timezone: string; hours: { day: number; start: string; end: string }[]; services: Service[]
 maxDepositCents: number; maxDiscountCents: number; maxRefundCents: number; callbackMinutes: number
 exceptionOwnerId: string; knowledge: { topic: string; value: string; version: string }[]; orbitTarget: string
}
export interface PolicyRow { version: number; body: string; owner_id: string; owner_version: number; created_at: number }
export interface Outcome {
 id: string; grant_id: string; case_id: string; case_version: number; call_id: string; language: Language; after_hours: number; policy_version: number
 caller_name: string; caller_email: string; identity_basis: string; identity_reported: number; payment_method_ref: string | null; created_at: number
}
export interface Step {
 id: string; outcome_id: string; kind: StepKind; state: string; request: string; request_hash: string; external_id: string | null
 readback: string | null; reason: string; attempts: number; amount_cents: number; version: number; created_at: number; updated_at: number
}
export interface Authorization {
 id: string; outcome_id: string; amount_cents: number; payee: string; purpose: string; language: Language; prompt: string; prompt_hash: string
 state: string; evidence: string | null; consumed_by: string | null; created_at: number; expires_at: number; decided_at: number | null
}
export interface ExceptionRow {
 id: string; outcome_id: string; kind: ExceptionKind; requested: string; request_hash: string; evidence: string; owner_id: string; status: string
 callback_due_at: number; notification: string; decided_by: string | null; decided_owner_version: number | null; decided_at: number | null
 note: string | null; consumed_by: string | null; created_at: number
}
const clock = /^([01]\d|2[0-3]):[0-5]\d$/
export function policy(value: unknown): Policy {
 const v = object(value)
 keys(v, ['businessName', 'timezone', 'hours', 'services', 'maxDepositCents', 'maxDiscountCents', 'maxRefundCents', 'callbackMinutes', 'exceptionOwnerId', 'knowledge', 'orbitTarget'])
 const timezone = text(v.timezone, 'timezone', 80)
 try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }) } catch { throw new Fault('invalid_timezone') }
 if (!Array.isArray(v.hours) || v.hours.length > 21 || !Array.isArray(v.services) || !v.services.length || v.services.length > 50 || !Array.isArray(v.knowledge) || v.knowledge.length > 100) throw new Fault('invalid_policy')
 const hours = v.hours.map(raw => { const h = object(raw); keys(h, ['day', 'start', 'end']); const start = text(h.start, 'start', 5), end = text(h.end, 'end', 5); if (!clock.test(start) || !clock.test(end) || start >= end) throw new Fault('invalid_hours'); return { day: integer(h.day, 'day', 0, 6), start, end } })
 const services = v.services.map(raw => { const s = object(raw); keys(s, ['id', 'name', 'eventTypeId', 'bookingPage', 'minutes', 'depositCents']); const bookingPage = text(s.bookingPage, 'bookingPage', 160); if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(bookingPage)) throw new Fault('invalid_bookingPage'); return { id: text(s.id, 'serviceId', 60), name: text(s.name, 'serviceName', 120), eventTypeId: text(s.eventTypeId, 'eventTypeId', 80), bookingPage, minutes: integer(s.minutes, 'minutes', 5, 480), depositCents: integer(s.depositCents, 'depositCents', 0, 1000000) } })
 if (new Set(services.map(s => s.id)).size !== services.length) throw new Fault('duplicate_service')
 const knowledge = v.knowledge.map(raw => { const k = object(raw); keys(k, ['topic', 'value', 'version']); return { topic: text(k.topic, 'topic', 80), value: text(k.value, 'value', 500), version: text(k.version, 'version', 80) } })
 const maxDepositCents = integer(v.maxDepositCents, 'maxDepositCents', 0, 1000000)
 if (services.some(s => s.depositCents > maxDepositCents)) throw new Fault('service_deposit_exceeds_limit')
 return { businessName: text(v.businessName, 'businessName', 120), timezone, hours, services, maxDepositCents, maxDiscountCents: integer(v.maxDiscountCents, 'maxDiscountCents', 0, 1000000), maxRefundCents: integer(v.maxRefundCents, 'maxRefundCents', 0, 1000000), callbackMinutes: integer(v.callbackMinutes, 'callbackMinutes', 1, 10080), exceptionOwnerId: text(v.exceptionOwnerId, 'exceptionOwnerId', 80), knowledge, orbitTarget: text(v.orbitTarget, 'orbitTarget', 200, true) }
}
/** Staffed hours are the policy windows in the business timezone; anything else is after hours. */
export function afterHours(p: Policy, at: number) {
 const parts = new Intl.DateTimeFormat('en-US', { timeZone: p.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
 const get = (type: string) => parts.find(part => part.type === type)!.value
 const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), now = `${get('hour')}:${get('minute')}`
 return p.hours.some(h => h.day === day && h.start <= now && now < h.end) ? 0 : 1
}
export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`
export function localTime(p: Policy, language: Language, at: number | string) {
 return new Intl.DateTimeFormat(language === 'es' ? 'es-US' : 'en-US', { timeZone: p.timezone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(at))
}
export function openInput(value: ObjectValue) {
 keys(value, ['callId', 'caseId', 'language', 'callerName', 'callerEmail', 'identityBasis', 'identityVerified', 'paymentMethodRef'])
 const email = text(value.callerEmail, 'callerEmail', 254)
 if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Fault('invalid_callerEmail')
 if (typeof value.identityVerified !== 'boolean') throw new Fault('invalid_identityVerified')
 const paymentMethodRef = value.paymentMethodRef === undefined ? null : text(value.paymentMethodRef, 'paymentMethodRef', 64)
 if (paymentMethodRef && !/^[A-Za-z0-9_-]{8,64}$/.test(paymentMethodRef)) throw new Fault('invalid_paymentMethodRef')
 return { callId: text(value.callId, 'callId', 100), caseId: text(value.caseId, 'caseId'), language: choice(value.language, languages, 'language'), callerName: text(value.callerName, 'callerName', 160), callerEmail: email, identityBasis: text(value.identityBasis, 'identityBasis', 100), identityVerified: value.identityVerified, paymentMethodRef }
}
