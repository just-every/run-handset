import type { Bindings } from '../../auth.server'
import { send, bearer, held, rejected, uncertain, type EdgeResult } from '../receptionist/edge'

// Stripe Payment Intents and Refunds. An Idempotency-Key replays the original answer, so
// retrying a lost response can never create a second charge or refund. Card data never
// reaches Handset: the saved payment-method reference is an opaque Stripe identifier.
const api = 'https://api.stripe.com/v1'
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()
const headers = (env: Bindings, key: string) => ({ ...bearer(env.HANDSET_STRIPE_KEY), 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': key })
export interface Deposit { outcomeId: string; amountCents: number; paymentMethod: string; description: string; key: string }
async function paymentReadback(env: Bindings, id: string, d: Deposit): Promise<EdgeResult> {
 const wire = await send(`${api}/payment_intents/${encodeURIComponent(id)}`, { method: 'GET', headers: { ...bearer(env.HANDSET_STRIPE_KEY) } })
 const observed = (result: EdgeResult): EdgeResult => ({ ...result, externalId: id })
 if (!wire) return observed(uncertain('stripe_readback_unavailable'))
 if (wire.status === 401) return observed(uncertain('stripe_credential_refused'))
 if (wire.status === 403) return observed(uncertain('stripe_payment_out_of_scope'))
 const p = wire.body, meta = (p.metadata ?? {}) as Record<string, unknown>
 if (wire.status !== 200 || p.id !== id || p.amount !== d.amountCents || p.currency !== 'usd' || meta.handset_outcome !== d.outcomeId) return observed(uncertain('stripe_readback_mismatch'))
 if (p.status !== 'succeeded') return observed(p.status === 'processing' ? uncertain('stripe_payment_processing') : rejected('stripe_payment_' + String(p.status)))
 if (p.amount_received !== d.amountCents) return observed(uncertain('stripe_readback_mismatch'))
 return { state: 'confirmed', externalId: id, readback: { id, status: 'succeeded', amountReceived: d.amountCents, currency: 'usd' }, reason: 'readback_matched' }
}
export async function charge(env: Bindings, d: Deposit, beforeEffect: () => Promise<void> = async () => {}): Promise<EdgeResult> {
 if (!env.HANDSET_STRIPE_KEY) return held('stripe_connector_unconfigured')
 await beforeEffect()
 const wire = await send(`${api}/payment_intents`, { method: 'POST', headers: headers(env, d.key), body: form({ amount: String(d.amountCents), currency: 'usd', payment_method: d.paymentMethod, confirm: 'true', off_session: 'true', description: d.description, 'metadata[handset_outcome]': d.outcomeId }) })
 if (!wire) return uncertain('stripe_response_lost')
 if (wire.status === 200 && typeof wire.body.id === 'string') return paymentReadback(env, wire.body.id, d)
 if (wire.status === 402 || wire.status === 400) return rejected('stripe_payment_declined')
 if (wire.status === 401 || wire.status === 403) return rejected('stripe_credential_refused')
 return uncertain('stripe_answer_unrecognised')
}
export async function readPayment(env: Bindings, id: string, d: Deposit) { return paymentReadback(env, id, d) }
export interface Refund { outcomeId: string; paymentIntent: string; amountCents: number; key: string }
export async function readRefund(env: Bindings, id: string, r: Refund): Promise<EdgeResult> {
 const read = await send(`${api}/refunds/${encodeURIComponent(id)}`, { method: 'GET', headers: { ...bearer(env.HANDSET_STRIPE_KEY) } })
 const observed = (result: EdgeResult): EdgeResult => ({ ...result, externalId: id })
 if (!read) return observed(uncertain('stripe_refund_readback_unavailable'))
 if (read.status === 401) return observed(uncertain('stripe_credential_refused'))
 if (read.status === 403) return observed(uncertain('stripe_refund_out_of_scope'))
 const meta = (read.body.metadata ?? {}) as Record<string, unknown>
 if (read.status !== 200 || read.body.id !== id || read.body.payment_intent !== r.paymentIntent || read.body.amount !== r.amountCents || meta.handset_outcome !== r.outcomeId) return observed(uncertain('stripe_refund_readback_mismatch'))
 if (read.body.status !== 'succeeded') return observed(read.body.status === 'pending' ? uncertain('stripe_refund_pending') : rejected('stripe_refund_' + String(read.body.status)))
 return { state: 'confirmed', externalId: id, readback: { id, status: 'succeeded', amount: r.amountCents }, reason: 'readback_matched' }
}
export async function refund(env: Bindings, r: Refund, beforeEffect: () => Promise<void> = async () => {}): Promise<EdgeResult> {
 if (!env.HANDSET_STRIPE_KEY) return held('stripe_connector_unconfigured')
 await beforeEffect()
 const wire = await send(`${api}/refunds`, { method: 'POST', headers: headers(env, r.key), body: form({ payment_intent: r.paymentIntent, amount: String(r.amountCents), 'metadata[handset_outcome]': r.outcomeId }) })
 if (!wire) return uncertain('stripe_response_lost')
 if (wire.status === 400 || wire.status === 402) return rejected('stripe_refund_refused')
 if (wire.status === 401 || wire.status === 403) return rejected('stripe_credential_refused')
 if (wire.status !== 200 || typeof wire.body.id !== 'string') return uncertain('stripe_answer_unrecognised')
 return readRefund(env, wire.body.id, r)
}
