// Network-edge fakes for the four receiving systems, shaped from their documented APIs:
// Dial operator bookings (creation key replays), Stripe Payment Intents and Refunds
// (Idempotency-Key replays), Orbit rer-delegation/1 effects and HappyToHelp workspace messages.
// Each fake keeps its own record store so tests read the receiving system independently.
const json = (Response, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
export const edgeOrigins = { dial: 'https://dial.synthetic-handset.test', stripe: 'https://api.stripe.com', orbit: 'https://orbit.synthetic-handset.test', helpdesk: 'https://help.synthetic-handset.test' }
export const edgeSecrets = { dial: 'synthetic-handset-701', stripe: 'synthetic-handset-702', orbit: 'synthetic-handset-703', helpdesk: 'synthetic-handset-704' }
export function createEdges() {
 const e = {
  origins: edgeOrigins, secrets: edgeSecrets,
  requests: [], slots: [], bookings: new Map(), bookingKeys: new Map(), intents: new Map(), intentKeys: new Map(), refunds: new Map(), refundKeys: new Map(),
  effects: new Map(), conversations: new Map([['synthetic-handset-710', { revision: 7, messages: [] }]]),
  readFailures: new Map(),
  handoffStates: new Map(), orbitExpired: false, orbitMissingScope: false, drop: new Set(), decline: false, orbitRevision: 3, orbitStale: 0,
  async handle(request, Response) {
   const url = new URL(request.url), host = url.origin, path = url.pathname
   if (!Object.values(edgeOrigins).includes(host)) return null
   const text = request.method === 'POST' ? await request.text() : '', auth = request.headers.get('authorization')
   e.requests.push({ host, method: request.method, path })
   const failure = request.method === 'GET' && e.readFailures.get(host + path)
   if (failure) return json(Response, { error: { code: 'synthetic-handset-refused-read' } }, failure)
   const lose = name => { if (e.drop.has(name)) { e.drop.delete(name); throw new Error('synthetic-handset-lost-response') } }
   if (host === edgeOrigins.dial) {
    if (path.startsWith('/api/public/book/')) return json(Response, { state: 'available', calendarRequired: false, week: '2026-10-26', slots: e.slots.map(startAt => ({ startAt })), recommendations: [], rankedSlots: [] })
    if (auth !== 'Bearer ' + edgeSecrets.dial) return json(Response, { error: { code: 'unauthorized' } }, 401)
    if (request.method === 'POST' && path === '/api/app/bookings') {
     const body = JSON.parse(text)
     if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.idempotencyKey)) return json(Response, { error: { code: 'invalid_request' } }, 400)
     const prior = e.bookingKeys.get(body.idempotencyKey)
     if (prior) { lose('dial'); return json(Response, e.bookings.get(prior), 200) }
     if (!e.slots.includes(new Date(Date.parse(body.startAt)).toISOString()) || [...e.bookings.values()].some(b => b.startAt === body.startAt)) return json(Response, { error: { code: 'slot_taken' } }, 409)
     const booking = { id: `synthetic-handset-booking-${e.bookings.size + 1}`, startAt: new Date(Date.parse(body.startAt)).toISOString(), state: 'confirmed', name: body.name, email: body.email, eventTypeId: body.eventTypeId, answers: body.answers }
     e.bookings.set(booking.id, booking); e.bookingKeys.set(body.idempotencyKey, booking.id)
     lose('dial')
     return json(Response, booking, 201)
    }
    const read = path.match(/^\/api\/app\/bookings\/([^/]+)$/)
    if (read && request.method === 'GET') return e.bookings.has(read[1]) ? json(Response, e.bookings.get(read[1])) : json(Response, { error: { code: 'not_found' } }, 404)
   }
   if (host === edgeOrigins.stripe) {
    if (auth !== 'Bearer ' + edgeSecrets.stripe) return json(Response, { error: { type: 'invalid_request_error' } }, 401)
    const key = request.headers.get('idempotency-key'), form = Object.fromEntries(new URLSearchParams(text))
    if (request.method === 'POST' && path === '/v1/payment_intents') {
     if (!key) return json(Response, { error: { type: 'invalid_request_error' } }, 400)
     if (e.intentKeys.has(key)) { lose('stripe'); return json(Response, e.intents.get(e.intentKeys.get(key))) }
     if (e.decline) return json(Response, { error: { type: 'card_error', code: 'card_declined' } }, 402)
     if (form.currency !== 'usd' || form.confirm !== 'true' || form.off_session !== 'true' || /card|number|cvc/i.test(text)) return json(Response, { error: { type: 'invalid_request_error' } }, 400)
     const intent = { id: `synthetic-handset-pi-${e.intents.size + 1}`, object: 'payment_intent', status: 'succeeded', amount: Number(form.amount), amount_received: Number(form.amount), currency: 'usd', metadata: { handset_outcome: form['metadata[handset_outcome]'] }, description: form.description }
     e.intents.set(intent.id, intent); e.intentKeys.set(key, intent.id)
     lose('stripe')
     return json(Response, intent)
    }
    const pi = path.match(/^\/v1\/payment_intents\/([^/]+)$/)
    if (pi && request.method === 'GET') return e.intents.has(pi[1]) ? json(Response, e.intents.get(pi[1])) : json(Response, { error: { type: 'invalid_request_error' } }, 404)
    if (request.method === 'POST' && path === '/v1/refunds') {
     if (e.refundKeys.has(key)) { lose('stripe-refund'); return json(Response, e.refunds.get(e.refundKeys.get(key))) }
     const intent = e.intents.get(form.payment_intent)
     const refunded = [...e.refunds.values()].filter(r => r.payment_intent === form.payment_intent).reduce((n, r) => n + r.amount, 0)
     if (!intent || Number(form.amount) + refunded > intent.amount_received) return json(Response, { error: { type: 'invalid_request_error' } }, 400)
     const refund = { id: `synthetic-handset-re-${e.refunds.size + 1}`, object: 'refund', status: 'succeeded', amount: Number(form.amount), payment_intent: form.payment_intent, metadata: { handset_outcome: form['metadata[handset_outcome]'] } }
     e.refunds.set(refund.id, refund); e.refundKeys.set(key, refund.id)
     lose('stripe-refund')
     return json(Response, refund)
    }
    const re = path.match(/^\/v1\/refunds\/([^/]+)$/)
    if (re && request.method === 'GET') return e.refunds.has(re[1]) ? json(Response, e.refunds.get(re[1])) : json(Response, { error: {} }, 404)
   }
   if (host === edgeOrigins.orbit) {
    if (e.orbitMissingScope) return json(Response, { error: { code: 'SCOPE_REQUIRED' } }, 403)
    if (e.orbitExpired || auth !== 'Bearer ' + edgeSecrets.orbit) return json(Response, { error: { code: 'DELEGATION_INVALID' } }, 401)
    if (path === '/api/delegation/v1/check') {
     const hook = e.orbitCheckHook; e.orbitCheckHook = null; if (hook) await hook()
     const target = url.searchParams.get('target')
     if (!/^opportunities\/synthetic-handset-720\/handoffs\/synthetic-handset-[0-9]+$/.test(target ?? '')) return json(Response, { error: { code: 'NOT_FOUND' } }, 404)
     return json(Response, { revision: e.orbitRevision, audienceRevision: 1, ...(request.headers.get('x-rer-record-state-schema') === 'crm.handoff-state/1' ? { recordState: { schema: 'crm.handoff-state/1', kind: 'crm.handoff', state: e.handoffStates.get(target) ?? 'open' } } : {}) })
    }
    if (request.method === 'POST' && path === '/api/delegation/v1/effects') {
     const body = JSON.parse(text)
     if (e.effects.has(body.operationKey)) { lose('orbit'); return json(Response, e.effects.get(body.operationKey).receipt) }
     if (e.orbitStale > 0) { e.orbitStale--; e.orbitRevision++; return json(Response, { error: { code: 'REVISION_CONFLICT' } }, 409) }
     if (body.operation !== 'orbit.handoff.upsert' || body.expectedRevision !== e.orbitRevision) return json(Response, { error: { code: 'REVISION_CONFLICT' } }, 409)
     const receipt = { operationKey: body.operationKey, target: body.target, status: 'applied' }
     e.effects.set(body.operationKey, { receipt, handoff: { target: body.target, content: body.content } })
     lose('orbit')
     return json(Response, receipt, 201)
    }
    const eff = path.match(/^\/api\/delegation\/v1\/effects\/([^/]+)$/)
    if (eff && request.method === 'GET') return e.effects.has(eff[1]) ? json(Response, e.effects.get(eff[1])) : json(Response, { error: { code: 'NOT_FOUND' } }, 404)
   }
   if (host === edgeOrigins.helpdesk) {
    if (auth !== 'Bearer ' + edgeSecrets.helpdesk) return json(Response, { error: { code: 'unauthorized' } }, 401)
    const c = path.match(/^\/api\/v1\/conversations\/([^/]+)(\/messages)?$/), conversation = c && e.conversations.get(c[1])
    if (!c || !conversation) return json(Response, { error: { code: 'not_found' } }, 404)
    if (!c[2] && request.method === 'GET') return json(Response, { id: c[1], status: 'open', revision: conversation.revision })
    if (c[2] && request.method === 'GET') return json(Response, { data: conversation.messages, next_cursor: null })
    if (c[2] && request.method === 'POST') {
     const body = JSON.parse(text)
     if (conversation.messages.some(m => m.localId === body.localId)) { lose('helpdesk'); return json(Response, conversation.messages.find(m => m.localId === body.localId)) }
     if (body.expectedRevision !== conversation.revision) return json(Response, { error: { code: 'revision_conflict' } }, 409)
     const message = { id: `synthetic-handset-msg-${conversation.messages.length + 1}`, localId: body.localId, content: body.content }
     conversation.messages.push(message); conversation.revision++
     lose('helpdesk')
     return json(Response, message, 201)
    }
   }
   return json(Response, { error: { code: 'not_found' } }, 404)
  },
 }
 return e
}
