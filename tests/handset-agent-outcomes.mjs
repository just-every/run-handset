import assert from 'node:assert/strict'
import { test } from 'node:test'
import { post, signIn } from './helpers/handset-auth.mjs'
import { mailText, mailTo, receptionistFixture } from './helpers/handset-receptionist.mjs'

const slot = days => { const d = new Date(Date.now() + days * 86400000); d.setUTCMinutes(0, 0, 0); return d.toISOString() }
const namedEmail = 'synthetic-handset-2@example.test'
async function readyToBook(f, n, language, caseId) {
 const call = await f.open(n, language, caseId), id = call.outcome.id
 const base = `outcomes/${id}/`
 const read = await f.ok(base + 'availability', { serviceId: 'furnace' })
 assert.ok(read.slots.some(s => s.startAt === f.edges.slots[0]))
 const booked = await f.ok(base + 'booking', { serviceId: 'furnace', startAt: f.edges.slots[0] })
 return { call, id, base, booked, read }
}
async function authorize(f, base, amountCents, digit = '1', callId) {
 const proposed = await f.ok(base + 'deposit/propose', { serviceId: 'furnace', amountCents })
 if (digit) {
  const prompt = await f.carrier(proposed.authorizationId, 'prompt', { CallSid: callId })
  assert.equal(prompt.status, 200, await prompt.clone().text())
  const answer = await f.carrier(proposed.authorizationId, 'confirm', { CallSid: callId, Digits: digit })
  assert.equal(answer.status, 200, await answer.clone().text())
 }
 return proposed
}

test('After hours in English and Spanish, one call books, takes a caller-authorized deposit and records both handoffs, each independently readable', async () => {
 const f = await receptionistFixture()
 try {
  f.edges.slots.push(slot(2), slot(3))
  await f.savePolicy()
  const done = []
  for (const [n, language, caseId] of [[1, 'en', f.cases[0]], [2, 'es', f.cases[1]]]) {
   const call = await f.open(n, language, caseId), id = call.outcome.id, base = `outcomes/${id}/`, callId = `synthetic-handset-call-${n}`
   assert.equal(call.outcome.after_hours, 1, 'the call arrived outside the policy hours')
   const facts = await f.ok(base + 'knowledge', { facts: [{ topic: 'deposit', value: '$50.00', sourceId: 'synthetic-handset-slate-1', version: 'k-12' }] })
   assert.equal(facts.results[0].status, 'confirmed'); assert.equal(facts.say, null)
   const read = await f.ok(base + 'availability', { serviceId: 'furnace' })
   const booked = await f.ok(base + 'booking', { serviceId: 'furnace', startAt: read.slots[n - 1].startAt })
   assert.equal(booked.step.state, 'confirmed')
   assert.match(booked.say.text, language === 'es' ? /^Su cita está confirmada para (?:lunes|martes|miércoles|jueves|viernes|sábado|domingo)/ : /^Your appointment is confirmed for /)
   // The caller hears the exact amount, payee and purpose, in their language, and must key it in herself.
   const proposed = await f.ok(base + 'deposit/propose', { serviceId: 'furnace', amountCents: 5000 })
   assert.match(proposed.prompt.text, language === 'es' ? /depósito de \$50\.00 para Furnace repair visit/ : /\$50\.00 deposit for Furnace repair visit/)
   assert.match(proposed.prompt.text, /Austin Service Co\./)
   const early = await f.agent(base + 'deposit', { authorizationId: proposed.authorizationId })
   assert.equal(early.status, 403); assert.equal((await early.json()).error, 'caller_authorization_required')
   const prompt = await f.carrier(proposed.authorizationId, 'prompt', { CallSid: callId })
   assert.match(await prompt.text(), language === 'es' ? /<Gather[^>]*>.*language="es-US"/s : /<Gather[^>]*>.*language="en-US"/s)
   assert.equal((await f.carrier(proposed.authorizationId, 'confirm', { CallSid: callId, Digits: '1' })).status, 200)
   const paid = await f.ok(base + 'deposit', { authorizationId: proposed.authorizationId })
   assert.equal(paid.step.state, 'confirmed'); assert.match(paid.say.text, /\$50\.00/)
   const crm = await f.ok(base + 'handoffs/crm', { summary: 'Furnace not heating; wants Monday' })
   const support = await f.ok(base + 'handoffs/support', { conversationId: 'synthetic-handset-710', summary: 'Furnace not heating' })
   assert.equal(crm.step.state, 'confirmed'); assert.equal(support.step.state, 'confirmed')
   done.push({ id, booked, paid, language })
  }
  // Independent readback from each receiving system, not from Handset's own claim.
  const bookings = [...f.edges.bookings.values()], intents = [...f.edges.intents.values()]
  assert.deepEqual(bookings.map(b => b.name), ['Jordan Lee', 'Rosa García']); assert.equal(new Set(bookings.map(b => b.startAt)).size, 2)
  assert.deepEqual(intents.map(i => [i.amount_received, i.currency, i.status]), [[5000, 'usd', 'succeeded'], [5000, 'usd', 'succeeded']])
  assert.deepEqual(intents.map(i => i.metadata.handset_outcome), done.map(d => d.id))
  const handoffs = [...f.edges.effects.values()]
  assert.equal(handoffs.length, 2)
  handoffs.forEach((h, i) => { assert.ok(h.handoff.content.includes(`booking confirmed ${bookings[i].id}`) && h.handoff.content.includes(`deposit confirmed ${intents[i].id}`), 'the CRM handoff links the booking and the deposit'); assert.ok(h.handoff.content.includes(done[i].id)) })
  const messages = f.edges.conversations.get('synthetic-handset-710').messages
  assert.equal(messages.length, 2); assert.ok(messages.every((m, i) => m.content.includes(done[i].id) && m.content.includes(`case ${f.cases[i]}`)))
  // A repeated request after confirmation touches no receiving system.
  const before = f.edges.requests.length
  for (const [path, data] of [['booking', { serviceId: 'furnace', startAt: bookings[0].startAt }], ['handoffs/crm', { summary: 'Furnace not heating; wants Monday' }]]) {
   const again = await f.ok(`outcomes/${done[0].id}/${path}`, data)
   assert.equal(again.replay, true); assert.equal(again.effectOccurred, false)
  }
  assert.equal(f.edges.requests.length, before)
  assert.equal((await f.runtime.sql('SELECT reserved_cents FROM hnd_grants')).results[0].reserved_cents, 10000, 'both deposits reserved against the credential budget')
  const page = await f.runtime.request('/app/receptionist', { headers: f.headers })
  const html = await page.text()
  assert.equal(page.status, 200); assert.match(html, /synthetic-handset-call-2/); assert.match(html, /Spanish/)
  assert.ok(!html.includes('synthetic-handset-pm-'), 'the saved payment reference is never shown')
 } finally { await f.runtime.close() }
})

test('Lost payment, booking, CRM and support responses stay uncertain until readback and never duplicate the effect', async () => {
 const f = await receptionistFixture()
 try {
  f.edges.slots.push(slot(2))
  await f.savePolicy()
  const call = await f.open(3, 'en', f.cases[2]), id = call.outcome.id, base = `outcomes/${id}/`
  await f.ok(base + 'availability', { serviceId: 'furnace' }); f.edges.drop.add('dial')
  const booked = await f.ok(base + 'booking', { serviceId: 'furnace', startAt: f.edges.slots[0] })
  assert.equal(booked.step.state, 'uncertain'); assert.equal(booked.effectOccurred, false)
  assert.doesNotMatch(booked.say.text, /confirmed for/i, 'no appointment is promised before readback')
  assert.equal(f.edges.bookings.size, 1, 'the booking did commit at Dial; only the answer was lost')
  const notice = mailTo(f.runtime, namedEmail).at(-1)
  assert.match(mailText(notice), /Failed provider action[\s\S]*"step":"booking"[\s\S]*Callback promised by/)
  const fixed = await f.ok(base + 'reconcile', { step: 'booking' })
  assert.equal(fixed.step.state, 'confirmed'); assert.equal(f.edges.bookings.size, 1, 'reconcile replays the same creation key, so there is one booking')
  const afterBooking = await (await f.agentGet(`outcomes/${id}`)).json()
  assert.equal(afterBooking.exceptions.find(x => x.kind === 'provider_failure').status, 'resolved')
  // The payment response is lost after Stripe charged; an agent retry cannot charge twice.
  const proposed = await authorize(f, base, 5000, '1', 'synthetic-handset-call-3')
  f.edges.drop.add('stripe')
  const lost = await f.ok(base + 'deposit', { authorizationId: proposed.authorizationId })
  assert.equal(lost.step.state, 'uncertain'); assert.match(lost.say.text, /Do not pay again/); assert.equal(f.edges.intents.size, 1)
  const retried = await f.ok(base + 'deposit', { authorizationId: proposed.authorizationId })
  assert.equal(retried.step.state, 'confirmed'); assert.equal(f.edges.intents.size, 1, 'the same idempotency key returns the original charge')
  assert.equal((await f.ok(base + 'deposit', { authorizationId: proposed.authorizationId })).replay, true)
  const forged = await f.agent(base + 'deposit', { authorizationId: proposed.authorizationId, callerAuthorized: true })
  assert.equal(forged.status, 400)
  // Orbit: a stale revision is re-read once; a lost answer is settled by the receipt.
  f.edges.orbitStale = 1; f.edges.drop.add('orbit')
  const crm = await f.ok(base + 'handoffs/crm', { summary: 'Furnace call' })
  assert.equal(crm.step.state, 'uncertain')
  const inventory = await (await f.runtime.request('/api/handset/delivery', { headers: f.headers })).json()
  assert.ok(inventory.steps.some(s => s.id === crm.step.id && s.state === 'uncertain' && s.outcome_id === id))
  assert.match(inventory.scopes.orbit, /handoff/)
  assert.equal((await f.ok(base + 'reconcile', { step: 'crm' })).step.state, 'confirmed'); assert.equal(f.edges.effects.size, 1)
  f.edges.drop.add('helpdesk')
  assert.equal((await f.ok(base + 'handoffs/support', { conversationId: 'synthetic-handset-710', summary: 'Furnace call' })).step.state, 'uncertain')
  assert.equal((await f.ok(base + 'reconcile', { step: 'support' })).step.state, 'confirmed')
  assert.equal(f.edges.conversations.get('synthetic-handset-710').messages.length, 1)
  // Two simultaneous booking requests cannot both reach the provider: the step claim is versioned.
  const second = await f.open(31, 'en', f.cases[2]); f.edges.slots.push(slot(4)); await f.ok(`outcomes/${second.outcome.id}/availability`, { serviceId: 'furnace' })
  const race = await Promise.all([1, 2].map(() => f.agent(`outcomes/${second.outcome.id}/booking`, { serviceId: 'furnace', startAt: f.edges.slots[1] })))
  assert.ok(race.every(r => [200, 409].includes(r.status)), JSON.stringify(await Promise.all(race.map(async r => ({ status: r.status, body: await r.clone().text() })))))
  assert.equal([...f.edges.bookings.values()].filter(b => b.startAt === f.edges.slots[1]).length, 1)
  assert.equal((await f.runtime.sql('SELECT reserved_cents FROM hnd_grants')).results[0].reserved_cents, 5000)
  // A provider may prune an old key. A possibly committed charge outside
  // Stripe's retention contract stays uncertain instead of making a new POST.
  f.edges.slots.unshift(slot(6))
  const aged = await readyToBook(f, 32, 'en', f.cases[2])
  const agedAuth = await authorize(f, aged.base, 5000, '1', 'synthetic-handset-call-32')
  f.edges.drop.add('stripe')
  const agedLost = await f.ok(aged.base + 'deposit', { authorizationId: agedAuth.authorizationId })
  assert.equal(agedLost.step.state, 'uncertain')
  await f.runtime.sql('UPDATE hnd_rx_steps SET created_at=? WHERE id=?', Date.now() - 24 * 3600000, agedLost.step.id)
  const stripePosts = () => f.edges.requests.filter(r => r.host === f.edges.origins.stripe && r.method === 'POST').length
  const beforeAgedRetry = stripePosts()
  assert.equal((await f.ok(aged.base + 'deposit', { authorizationId: agedAuth.authorizationId })).step.state, 'uncertain')
  assert.equal(stripePosts(), beforeAgedRetry, 'expired deduplication retention forbids a blind charge replay')
  // A creation answer can arrive before its independent read becomes unavailable.
  // Retain that receiving identity so repair is read-only, even beyond key retention.
  f.edges.slots.unshift(slot(8))
  const knownCall = await f.open(33, 'en', f.cases[2]), knownBase = `outcomes/${knownCall.outcome.id}/`
  await f.ok(knownBase + 'availability', { serviceId: 'furnace' })
  async function repairKnown(kind, create, remoteId, readPath, reasons, mutate) {
   const readUrl = (kind === 'booking' ? f.edges.origins.dial : f.edges.origins.stripe) + readPath
   f.edges.readFailures.set(readUrl, 503)
   const pending = await create()
   assert.equal(pending.step.state, 'uncertain', kind + ' is not confirmed by its creation answer')
   assert.equal(pending.step.externalId, remoteId, kind + ' retains the receiving identity')
   const writes = () => f.edges.requests.filter(r => r.method === 'POST').length
   const before = writes()
   for (const [status, reason] of [[401, reasons[0]], [403, reasons[1]]]) {
    f.edges.readFailures.set(readUrl, status)
    await f.runtime.restart()
    const blocked = await f.ok(knownBase + 'reconcile', { step: kind })
    assert.equal(blocked.step.state, 'uncertain'); assert.equal(blocked.reason, reason)
    assert.equal(blocked.step.externalId, remoteId)
    assert.equal(writes(), before, 'refused readback never replays a known ' + kind)
    const inventory = await (await f.runtime.request('/api/handset/delivery', { headers: f.headers })).json()
    assert.ok(inventory.steps.some(s => s.id === pending.step.id && s.external_id === remoteId && s.reason === reason && s.state === 'uncertain'))
   }
   f.edges.readFailures.delete(readUrl)
   const restore = mutate()
   const mismatch = await f.ok(knownBase + 'reconcile', { step: kind })
   assert.equal(mismatch.step.state, 'uncertain'); assert.match(mismatch.reason, /readback_mismatch/)
   assert.equal(writes(), before, 'mismatched readback cannot confirm or recreate the effect')
   restore()
   await f.runtime.sql('UPDATE hnd_rx_steps SET created_at=? WHERE id=?', Date.now() - 24 * 3600000, pending.step.id)
   await f.runtime.restart()
   const confirmed = await f.ok(knownBase + 'reconcile', { step: kind })
   assert.equal(confirmed.step.state, 'confirmed'); assert.equal(confirmed.step.id, pending.step.id)
   assert.equal(confirmed.step.externalId, remoteId); assert.equal(writes(), before, 'known ' + kind + ' repairs using only GET')
  }
  const bookingId = `synthetic-handset-booking-${f.edges.bookings.size + 1}`
  await repairKnown('booking', () => f.ok(knownBase + 'booking', { serviceId: 'furnace', startAt: f.edges.slots[0] }), bookingId, '/api/app/bookings/' + bookingId,
   ['dial_credential_refused', 'dial_booking_out_of_scope'], () => {
    const b = f.edges.bookings.get(bookingId), old = b.answers
    b.answers = { handsetCall: 'synthetic-handset-foreign-call' }; return () => { b.answers = old }
   })
  const knownAuth = await authorize(f, knownBase, 5000, '1', 'synthetic-handset-call-33')
  const intentId = `synthetic-handset-pi-${f.edges.intents.size + 1}`
  await repairKnown('deposit', () => f.ok(knownBase + 'deposit', { authorizationId: knownAuth.authorizationId }), intentId, '/v1/payment_intents/' + intentId,
   ['stripe_credential_refused', 'stripe_payment_out_of_scope'], () => {
    const p = f.edges.intents.get(intentId), old = p.metadata
    p.metadata = { handset_outcome: 'synthetic-handset-foreign-outcome' }; return () => { p.metadata = old }
   })
  const exception = await f.ok(knownBase + 'escalations', { kind: 'out_of_policy_refund', amountCents: 1000, detail: 'Named person approved the exact correction' })
  const approval = await post(f.runtime, `/api/handset/receptionist/exceptions/${exception.exceptionId}/decision`, { decision: 'approve', confirm: 'decide exact exception', note: 'Refund exactly this amount once' }, { cookie: f.named.cookie })
  assert.equal(approval.status, 200, await approval.clone().text())
  const refundId = `synthetic-handset-re-${f.edges.refunds.size + 1}`
  await repairKnown('refund', () => f.ok(knownBase + 'refund', { exceptionId: exception.exceptionId }), refundId, '/v1/refunds/' + refundId,
   ['stripe_credential_refused', 'stripe_refund_out_of_scope'], () => {
    const r = f.edges.refunds.get(refundId), old = r.metadata
    r.metadata = { handset_outcome: 'synthetic-handset-foreign-outcome' }; return () => { r.metadata = old }
   })
  assert.equal(f.edges.bookings.size, 4); assert.equal(f.edges.intents.size, 3); assert.equal(f.edges.refunds.size, 1)
  assert.equal((await f.runtime.sql('SELECT reserved_cents FROM hnd_grants WHERE id=?', f.issued.grant.id)).results[0].reserved_cents, 15000, 'uncertain reads never release a possibly committed deposit reservation')
  const delivery = await (await f.runtime.request('/api/handset/delivery', { headers: f.headers })).json()
  const connection = kind => delivery.connections.find(c => c.id === kind)
  assert.deepEqual(connection('orbit').mappedRecords, [{ target: f.orbitTarget }])
  assert.ok(connection('helpdesk').mappedRecords.some(r => r.caseId === f.cases[2] && r.conversationId === 'synthetic-handset-710'))
  assert.ok(connection('dial').mappedRecords.some(r => r.serviceId === 'furnace' && r.eventTypeId === [...f.edges.bookings.values()][0].eventTypeId))
  assert.equal(connection('stripe').attempts.uncertain, 1)
  assert.equal(connection('stripe').attempts.confirmed, 3)
  assert.ok(connection('stripe').lastSuccessfulAt > 0)
  assert.ok(connection('stripe').oldestUnresolvedAgeMs >= 0)
  assert.equal(delivery.steps.find(s => s.id === agedLost.step.id).repair.mode, 'human_resolution_required')
  for (const secret of Object.values(f.edges.secrets)) assert.ok(!JSON.stringify(delivery).includes(secret))
  const beforeInspection = f.edges.requests.filter(r => r.method === 'POST').length
  for (const connector of ['dial','stripe','orbit','helpdesk']) {
   const response = await post(f.runtime, '/api/handset/delivery/inspect', { connector, mappingVersion: 1, confirm: 'inspect current connector read scope' }, f.headers)
   assert.equal(response.status, 200, await response.clone().text())
   const inspected = await response.json()
   assert.ok(inspected.observations.length > 0 && inspected.observations.every(o => o.state === 'available'), connector + ' selected receiving scope is independently readable')
   assert.ok(inspected.observations.some(o => o.delivery.state === 'confirmed' && o.delivery.stepId && o.delivery.lagMs >= 0), connector + ' current receiving effect has an exact independent receipt and observed lag')
   assert.equal(inspected.effectsChanged, false)
  }
  await f.runtime.restart()
  const inspected = await (await f.runtime.request('/api/handset/delivery', { headers: f.headers })).json()
  assert.ok(inspected.connections.every(c => c.inspections.length > 0 && c.inspections.every(i => i.state === 'available' && !i.stale && i.last_success_at > 0)))
  assert.ok(inspected.connections.every(c => c.remoteLagMs >= 0 && c.remoteLagMs !== null && c.lastCurrentDeliveryAt > 0), 'current receiving receipts and lag survive restart for all four connector families')
  assert.equal(f.edges.requests.filter(r => r.method === 'POST').length, beforeInspection)
 } finally { await f.runtime.close() }
})

test('Conflicting knowledge, out-of-policy refund and emergency become owned exceptions; only the named person decides and no promise precedes confirmation', async () => {
 const f = await receptionistFixture()
 try {
  f.edges.slots.push(slot(2), slot(3))
  await f.savePolicy()
  // Conflicting and missing knowledge, in Spanish: nothing is booked or charged on a contested fact.
  const es = await f.open(4, 'es', f.cases[3]), esBase = `outcomes/${es.outcome.id}/`
  const conflict = await f.ok(esBase + 'knowledge', { facts: [{ topic: 'deposit', value: '$25.00', sourceId: 'synthetic-handset-slate-2', version: 'k-11' }, { topic: 'warranty', value: 'Five years', sourceId: 'synthetic-handset-chest-1', version: 'k-3' }] })
  assert.deepEqual(conflict.results.map(r => r.status), ['conflict', 'unknown']); assert.match(conflict.say.text, /No puedo decidir eso yo misma/)
  const sent = mailTo(f.runtime, namedEmail).length
  const noticeText = mailText(mailTo(f.runtime, namedEmail).find(m => /Conflicting knowledge/.test(m.subject)))
  assert.ok(noticeText.includes('$25.00') && noticeText.includes('$50.00') && noticeText.includes('k-11') && noticeText.includes('Rosa García'), 'the named person receives the exact conflict and its evidence')
  const again = await f.ok(esBase + 'knowledge', { facts: [{ topic: 'deposit', value: '$25.00', sourceId: 'synthetic-handset-slate-2', version: 'k-11' }] })
  assert.equal(again.escalated.length, 1); assert.equal(mailTo(f.runtime, namedEmail).length, sent, 'a repeat of the same exception sends no second notice')
  await f.ok(esBase + 'availability', { serviceId: 'furnace' })
  const blocked = await f.agent(esBase + 'booking', { serviceId: 'furnace', startAt: f.edges.slots[0] })
  assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error, 'blocked_by_open_exception'); assert.equal(f.edges.bookings.size, 0)
  // An out-of-policy discount stops at an exception; the exact approved amount then proceeds.
  const d = await readyToBook(f, 6, 'en', f.cases[4])
  const cut = await f.ok(d.base + 'deposit/propose', { serviceId: 'furnace', amountCents: 4000 })
  assert.equal(cut.state, 'escalated'); assert.equal(cut.effectOccurred, false)
  assert.equal((await f.runtime.sql('SELECT count(*) AS n FROM hnd_rx_authorizations')).results[0].n, 0, 'no charge was even proposed')
  assert.equal((await f.agent(d.base + 'deposit/propose', { serviceId: 'furnace', amountCents: 6000 })).status, 403)
  const decision = (who, id, body = {}) => post(f.runtime, `/api/handset/receptionist/exceptions/${id}/decision`, { decision: 'approve', note: 'Approved once', confirm: 'decide exact exception', ...body }, who)
  assert.equal((await decision({ authorization: 'Bearer ' + f.issued.token }, cut.exceptionId)).status, 401, 'the agent credential cannot reach the decision door')
  const notNamed = await decision(f.headers, cut.exceptionId)
  assert.equal(notNamed.status, 403); assert.equal((await notNamed.json()).error, 'named_person_required')
  assert.equal((await decision({ cookie: f.named.cookie }, cut.exceptionId)).status, 200)
  assert.equal((await decision({ cookie: f.named.cookie }, cut.exceptionId)).status, 409, 'a decision is made once')
  const discounted = await f.ok(d.base + 'deposit/propose', { serviceId: 'furnace', amountCents: 4000, discountExceptionId: cut.exceptionId })
  assert.equal(discounted.amountCents, 4000)
  assert.equal((await f.carrier(discounted.authorizationId, 'confirm', { CallSid: 'synthetic-handset-call-6', Digits: '1' }, { sign: false })).status, 403, 'an unsigned key press cannot authorize')
  assert.equal((await f.carrier(discounted.authorizationId, 'confirm', { CallSid: 'synthetic-handset-call-other', Digits: '1' })).status, 403, 'another call cannot authorize')
  assert.equal((await f.agent(d.base + 'deposit', { authorizationId: discounted.authorizationId })).status, 403)
  await f.carrier(discounted.authorizationId, 'confirm', { CallSid: 'synthetic-handset-call-6', Digits: '1' })
  assert.equal((await f.ok(d.base + 'deposit', { authorizationId: discounted.authorizationId })).step.state, 'confirmed')
  assert.equal([...f.edges.intents.values()][0].amount_received, 4000)
  // Refund: outside policy until the named person approves that exact amount, then exactly one refund.
  const ask = await f.ok(d.base + 'escalations', { kind: 'out_of_policy_refund', amountCents: 4000, detail: 'Caller wants the whole deposit back' })
  assert.equal(ask.state, 'escalated'); assert.match(ask.say.text, /cannot decide that myself/)
  const refundNotice = mailText(mailTo(f.runtime, namedEmail).find(m => /refund/i.test(m.subject)))
  assert.ok(refundNotice.includes('$40.00') && refundNotice.includes('synthetic-handset-pi-1'))
  assert.equal((await f.agent(d.base + 'refund', { exceptionId: ask.exceptionId })).status, 403)
  assert.equal(f.edges.refunds.size, 0)
  assert.equal((await decision({ cookie: f.named.cookie }, ask.exceptionId)).status, 200)
  const refunded = await f.ok(d.base + 'refund', { exceptionId: ask.exceptionId })
  assert.equal(refunded.step.state, 'confirmed'); assert.equal(f.edges.refunds.size, 1)
  assert.equal((await f.ok(d.base + 'refund', { exceptionId: ask.exceptionId })).replay, true); assert.equal(f.edges.refunds.size, 1)
  assert.equal((await f.agent(d.base + 'escalations', { kind: 'out_of_policy_refund', amountCents: 9000, detail: 'More than was paid' })).status, 403)
  // Emergency: the caller gets a real next step and a person gets the request; nothing is dispatched.
  const requests = f.edges.requests.length
  const emergency = await f.ok(d.base + 'escalations', { kind: 'emergency_dispatch', detail: 'Gas smell, send a technician now' })
  assert.match(emergency.say.text, /call 911 now[\s\S]*cannot dispatch/); assert.equal(emergency.effectOccurred, false)
  assert.ok(emergency.callbackDueAt > Date.now() && emergency.callbackDueAt <= Date.now() + 45 * 60000 + 1000)
  assert.equal(emergency.notification, 'sent')
  assert.equal((await decision({ cookie: f.named.cookie }, emergency.exceptionId)).status, 200)
  assert.equal(f.edges.requests.length, requests, 'approving a dispatch records the decision; no provider is called')
  const inbox = await (await f.runtime.request('/api/handset/receptionist', { headers: { cookie: f.named.cookie } })).json()
  assert.ok(inbox.exceptions.some(x => x.id === emergency.exceptionId && x.status === 'approved' && x.owner_id === 'synthetic-handset-2'))
  // Revoking the credential stops the receptionist at once.
  assert.equal((await post(f.runtime, `/api/handset/grants/${f.issued.grant.id}/revoke`, {}, f.headers)).status, 200)
  assert.equal((await f.agent(d.base + 'availability', { serviceId: 'furnace' })).status, 401)
 } finally { await f.runtime.close() }
 // A receiving system that is not installed is held honestly: nothing is claimed, the owner is told.
 const bare = await receptionistFixture({ connectors: false })
 try {
  await bare.savePolicy()
  const call = await bare.open(7, 'en', bare.cases[0])
  const held = await bare.ok(`outcomes/${call.outcome.id}/availability`, { serviceId: 'furnace' })
  assert.equal(held.state, 'held'); assert.match(held.say.text, /not connected yet/)
  const booking = await bare.agent(`outcomes/${call.outcome.id}/booking`, { serviceId: 'furnace', startAt: new Date(Date.now() + 172800000).toISOString() })
  assert.equal(booking.status, 409)
  assert.equal((await bare.agent('outcomes', { callId: 'x' })).status, 400)
  assert.equal((await post(bare.runtime, '/api/handset/receptionist/policy', { policy: {}, expectedVersion: 1, confirm: 'set receptionist limits' }, { authorization: 'Bearer ' + bare.issued.token })).status, 401)
 } finally { await bare.runtime.close() }
})

test('A case-scoped receptionist hands off support only to the conversation the owner mapped to its case', async () => {
 const f = await receptionistFixture()
 try {
  await f.savePolicy()
  // Another customer's existing support conversation at the same helpdesk.
  f.edges.conversations.set('synthetic-handset-711', { revision: 2, messages: [] })
  const definition = { scopes: ['send'], tools: ['outcome.work'], records: [f.cases[0]], numbers: [], recipients: [], budgetCents: 30000, policyRevision: 'owner-only-v1' }
  const scoped = await f.create('/api/handset/mcp/consent', { name: 'One-case receptionist', definition, expiresAt: Date.now() + 3600000, confirm: 'approve scoped credential' })
  const agent = (path, data) => post(f.runtime, '/api/handset/application/receptionist/' + path, data, { authorization: 'Bearer ' + scoped.token })
  const opened = await agent('outcomes', { callId: 'synthetic-handset-call-41', caseId: f.cases[0], language: 'en', callerName: 'Jordan Lee', callerEmail: 'synthetic-handset-caller-41@example.test', identityBasis: 'callback_to_number_on_file', identityVerified: true })
  assert.equal(opened.status, 201, await opened.clone().text())
  const support = `outcomes/${(await opened.json()).outcome.id}/handoffs/support`, requests = f.edges.requests.length
  const foreign = await agent(support, { conversationId: 'synthetic-handset-711', summary: 'Furnace not heating' })
  assert.equal(foreign.status, 403, await foreign.clone().text())
  assert.equal(f.edges.conversations.get('synthetic-handset-711').messages.length, 0)
  assert.equal(f.edges.requests.length, requests, 'the installation helpdesk credential is never used for an unmapped conversation')
  const mapped = await agent(support, { conversationId: 'synthetic-handset-710', summary: 'Furnace not heating' })
  assert.equal(mapped.status, 200, await mapped.clone().text()); assert.equal((await mapped.json()).step.state, 'confirmed')
  assert.ok(f.edges.conversations.get('synthetic-handset-710').messages.at(-1).content.includes(`case ${f.cases[0]}`))
 } finally { await f.runtime.close() }
})


// Follow-ups use the documented Orbit handoff state observation. These are
// independent receiver records; they do not pretend the session-only task API is delegated.
async function promiseFixture(f, n, text = 'Send the written furnace estimate') {
 const record = await f.create('/api/handset/records', { kind: 'promise', sourceId: `synthetic-handset-promise-${n}`, occurredAt: Date.now(), caseId: f.cases[n % f.cases.length], data: { text, dueAt: Date.now() - 1000 } })
 const source = record.record
 const input = { caseId: source.case_id, sourceId: source.id, obligation: text, dueAt: JSON.parse(source.data).dueAt,
  confirmationBasis: 'Current owning Orbit handoff is completed; delivery alone is insufficient',
  target: `opportunities/synthetic-handset-720/handoffs/synthetic-handset-${800 + n}`, draft: `Here is the estimate for Austin, Texas. ${text}` }
 return { source, input }
}
const followupAction = async (f, row, op, data = {}) => {
 const response = await post(f.runtime, `/api/handset/followups/${row.id}/${op}`, { revision: row.revision, ...data }, f.headers)
 assert.equal(response.status, 200, await response.clone().text())
 return (await response.json()).followup
}

test('Cited promises stay open after delivery and show two independently confirmed and one due after restart', async () => {
 const f = await receptionistFixture()
 try {
  const rows = []
  for (let n = 0; n < 3; n++) {
   const { input } = await promiseFixture(f, n, n === 1 ? 'Enviar el presupuesto por escrito' : 'Send the written furnace estimate')
   const made = await f.create('/api/handset/followups', input)
   let row = made.followup
   assert.equal((await f.create('/api/handset/followups', input, f.headers, 200)).replay, true)
   assert.equal((await post(f.runtime, '/api/handset/followups', { ...input, obligation: 'Invent a refund promise' }, f.headers)).status, 409)
   assert.equal((await post(f.runtime, `/api/handset/followups/${row.id}/deliver`, { revision: row.revision }, f.headers)).status, 403)
   row = await followupAction(f, row, 'approve', { confirm: 'approve exact cited handoff' })
   row = await followupAction(f, row, 'deliver')
   assert.equal(row.delivery, 'received'); assert.equal(row.status, 'open', 'sent is never done')
   const remote = f.edges.effects.get(row.operation_key)
   assert.ok(remote.handoff.content.includes(input.sourceId) && remote.handoff.content.includes(input.caseId) && remote.handoff.content.includes(input.obligation), 'receiver has the cited source and exact obligation')
   rows.push(row)
  }
  for (const row of rows.slice(0, 2)) f.edges.handoffStates.set(row.target, 'completed')
  for (let n = 0; n < rows.length; n++) rows[n] = await followupAction(f, rows[n], 'reconcile')
  await f.runtime.restart()
  const response = await f.runtime.request('/api/handset/followups', { headers: f.headers })
  const list = await response.json()
  assert.equal(response.status, 200)
  assert.deepEqual(list.counts, { confirmed: 2, declined: 0, due: 1, open: 1 })
  assert.equal(f.edges.effects.size, 3)
  assert.equal((await f.runtime.request('/api/handset/followups')).status, 401)
  assert.equal((await post(f.runtime, '/api/handset/followups', {}, { authorization: 'Bearer ' + f.issued.token })).status, 401, 'a bearer is not a human approver')
 } finally { await f.runtime.close() }
})

test('Human edits and source corrections fence stale promises; lost handoff responses reconcile without a second write', async () => {
 const f = await receptionistFixture()
 try {
  const p = await promiseFixture(f, 3)
  let row = (await f.create('/api/handset/followups', p.input)).followup
  row = await followupAction(f, row, 'approve', { confirm: 'approve exact cited handoff' })
  const stale = row
  row = await followupAction(f, row, 'edit', { draft: 'A person corrected the estimate', dueAt: Date.now() - 1000 })
  assert.equal(row.delivery, 'draft')
  assert.equal((await post(f.runtime, `/api/handset/followups/${row.id}/deliver`, { revision: stale.revision }, f.headers)).status, 409)
  assert.equal((await post(f.runtime, `/api/handset/followups/${row.id}/deliver`, { revision: row.revision }, f.headers)).status, 403)
  row = await followupAction(f, row, 'approve', { confirm: 'approve exact cited handoff' })
  f.edges.drop.add('orbit')
  row = await followupAction(f, row, 'deliver')
  assert.equal(row.delivery, 'uncertain'); assert.equal(f.edges.effects.size, 1)
  const posts = () => f.edges.requests.filter(r => r.host === f.edges.origins.orbit && r.method === 'POST').length
  const before = posts()
  await f.runtime.restart()
  f.edges.orbitExpired = true
  row = await followupAction(f, row, 'reconcile')
  assert.equal(row.status, 'open'); assert.match(row.reason, /oauth_refused/)
  f.edges.orbitExpired = false
  row = await followupAction(f, row, 'reconcile')
  assert.equal(row.delivery, 'received'); assert.equal(row.status, 'open'); assert.equal(posts(), before)
  f.edges.handoffStates.set(row.target, 'cancelled')
  row = await followupAction(f, row, 'reconcile'); assert.equal(row.status, 'declined')
  // A later correction invalidates an approved, still-unstarted promise.
  const p2 = await promiseFixture(f, 4)
  let second = (await f.create('/api/handset/followups', p2.input)).followup
  second = await followupAction(f, second, 'approve', { confirm: 'approve exact cited handoff' })
  await f.create('/api/handset/records', { kind: 'promise', sourceId: 'synthetic-handset-corrected-promise-4', occurredAt: Date.now(), caseId: p2.source.case_id, supersedesId: p2.source.id, data: { text: 'Customer no longer needs an estimate', dueAt: Date.now() } })
  assert.equal((await post(f.runtime, `/api/handset/followups/${second.id}/deliver`, { revision: second.revision }, f.headers)).status, 409)
  assert.equal(posts(), before)
  second = await followupAction(f, second, 'cancel', { note: 'Promise withdrawn by customer' })
  assert.equal(second.status, 'canceled')

  // Current completion cannot race a human edit of the underlying case.
  const p3 = await promiseFixture(f, 5)
  let third = (await f.create('/api/handset/followups', p3.input)).followup
  third = await followupAction(f, third, 'approve', { confirm: 'approve exact cited handoff' })
  third = await followupAction(f, third, 'deliver')
  f.edges.handoffStates.set(third.target, 'completed')
  f.edges.orbitCheckHook = async () => {
   const changed = await post(f.runtime, `/api/handset/cases/${third.case_id}`, { title: 'Human changed the promise while readback was in flight', version: third.case_version }, f.headers)
   assert.equal(changed.status, 200)
  }
  const staleCompletion = await post(f.runtime, `/api/handset/followups/${third.id}/reconcile`, { revision: third.revision }, f.headers)
  assert.equal(staleCompletion.status, 409)
  const current = await (await f.runtime.request('/api/handset/followups', { headers: f.headers })).json()
  assert.equal(current.followups.find(x => x.id === third.id).status, 'open')

 } finally { await f.runtime.close() }
})


test('A signed inbound STOP cancels unstarted follow-ups without claiming remote recall', async () => {
 const f = await receptionistFixture()
 try {
  const { sourceFixture } = await import('./helpers/handset-sources.mjs')
  const edge = await sourceFixture(f.runtime)
  const call = await edge.callback({ CallSid: 'synthetic-handset-950', CallStatus: 'completed', SequenceNumber: '0', Timestamp: new Date().toISOString() })
  assert.equal(call.status, 200)
  const caseId = (await call.json()).caseId
  const promise = await f.create('/api/handset/records', { kind: 'promise', sourceId: 'synthetic-handset-stop-promise', occurredAt: Date.now(), caseId, data: { text: 'Send my written quote', dueAt: Date.now() } })
  let row = (await f.create('/api/handset/followups', { caseId, sourceId: promise.record.id, obligation: 'Send my written quote', dueAt: Date.now(), confirmationBasis: 'Current handoff completed', target: 'opportunities/synthetic-handset-720/handoffs/synthetic-handset-950', draft: 'Your written quote' })).followup
  row = await followupAction(f, row, 'approve', { confirm: 'approve exact cited handoff' })
  const stop = { MessageSid: 'synthetic-handset-951', MessageStatus: 'received', Body: 'STOP', Timestamp: new Date().toISOString() }
  assert.equal((await edge.callback(stop, { signature: false })).status, 403)
  assert.equal((await edge.callback(stop)).status, 200)
  const list = await (await f.runtime.request('/api/handset/followups', { headers: f.headers })).json()
  const canceled = list.followups.find(x => x.id === row.id)
  assert.equal(canceled.status, 'canceled'); assert.equal(canceled.delivery, 'canceled')
  assert.match(canceled.reason, /STOP/)
  assert.equal((await post(f.runtime, `/api/handset/followups/${row.id}/deliver`, { revision: canceled.revision }, f.headers)).status, 409)
  assert.equal(f.edges.effects.size, 0)
  await f.runtime.restart()
  const after = await (await f.runtime.request('/api/handset/followups', { headers: f.headers })).json()
  assert.equal(after.followups.find(x => x.id === row.id).status, 'canceled')
 } finally { await f.runtime.close() }
})


test('Number correction cases preserve named follow-up and withhold port, emergency and rotation effects without qualified authority', async () => {
 const f = await receptionistFixture()
 try {
  const { sourceFixture } = await import('./helpers/handset-sources.mjs')
  const source = await sourceFixture(f.runtime), dueAt = Date.now() - 1000
  const record = async (kind, name, data) => (await f.create('/api/handset/records', { kind, sourceId: `synthetic-handset-compliance-${name}`, occurredAt: Date.now(), data })).record
  const endpoint = await record('endpoint', 'endpoint', { name: 'Rosa office phone', platform: 'desktop' })
  const location = await record('location', 'location', { name: 'Austin second floor', timezone: 'America/Chicago' })
  const notice = await record('comment', 'notice', { text: 'Authorized employee reported a move; carrier validation pending' })
  const reports = [
   ['port_pin', { port_in_request_sid: 'synthetic-handset-port-1', phone_number_sid: 'synthetic-handset-port-number-1', port_in_phone_number_status: 'port_rejected', rejection_reason: 'INVALID_PIN' }],
   ['e911_move', { endpointId: endpoint.id, locationRecordId: location.id, changeNoticeRecordId: notice.id }],
   ['brand_registration', { sid: 'synthetic-handset-brand-1', account_sid: source.account, status: 'FAILED', failure_reason: 'Business facts need representative review' }],
   ['tollfree_verification', { sid: 'synthetic-handset-tfv-1', account_sid: source.account, tollfree_phone_number: '+15125550125', status: 'TWILIO_REJECTED', rejection_reason: 'Attestation required', error_code: 30442 }],
   ['reputation', { network: 'Controlled receiving network A', observedAt: Date.now(), label: 'spam', evidenceRecordId: notice.id }],
  ]
  const cases = []
  for (const [kind, report] of reports) {
   const input = { sourceId: source.source.id, kind, report, dueAt, confirm: 'prepare exact compliance case' }
   let row = (await f.create('/api/handset/compliance', input)).case
   assert.equal((await f.create('/api/handset/compliance', input, f.headers, 200)).replay, true)
   assert.equal(row.owner_id, 'synthetic-handset-1'); assert.equal(row.provider_state, 'unknown')
   assert.ok(row.plan.length > 50)
   const review = await post(f.runtime, `/api/handset/compliance/${row.id}/review`, { revision: row.revision, note: 'Prepare only; legal facts and live provider approval remain unproved', confirm: 'review exact correction preparation' }, f.headers)
   assert.equal(review.status, 200); row = (await review.json()).case
   const held = await post(f.runtime, `/api/handset/compliance/${row.id}/submit`, { revision: row.revision }, f.headers)
   assert.equal(held.status, 202); assert.equal((await held.json()).effectOccurred, false)
   cases.push(row)
  }
  assert.match(cases.find(r => r.kind === 'reputation').plan, /direct business-representative/)
  // No PIN is accepted through this preparation or receipt API.
  assert.equal((await post(f.runtime, '/api/handset/compliance', { sourceId: source.source.id, kind: 'port_pin', report: { ...reports[0][1], port_out_pin: 'synthetic-handset-private-pin' }, dueAt, confirm: 'prepare exact compliance case' }, f.headers)).status, 400)
  const port = cases[0]
  const portUrl = 'https://numbers.twilio.com/v1/Porting/PortIn/synthetic-handset-port-1/PhoneNumber/synthetic-handset-port-number-1'
  const portReceipt = { port_in_request_sid: 'synthetic-handset-port-1', phone_number_sid: 'synthetic-handset-port-number-1', account_sid: source.account, phone_number: '+15125550125', port_in_phone_number_status: 'port_pending', port_date: '2026-11-02T18:00:00Z', port_out_pin: 'synthetic-handset-private-pin' }
  const detail = async () => {
   const response = await f.runtime.request(`/api/handset/compliance/${port.id}`, { headers: f.headers })
   assert.equal(response.status, 200)
   return response.json()
  }
  f.runtime.twilioResources.set(portUrl, portReceipt)
  const response = await post(f.runtime, `/api/handset/compliance/${port.id}/readback`, { revision: port.revision, confirm: 'read exact compliance receipt' }, f.headers)
  assert.equal(response.status, 200)
  const observed = (await response.json()).case
  assert.equal(observed.provider_state, 'port_pending'); assert.equal(observed.status, 'follow_up')
  assert.match(observed.readback, /unproved/); assert.ok(!JSON.stringify(observed).includes('synthetic-handset-private-pin'))
  // Once a receipt is retained, unavailable or foreign provider evidence must
  // leave the same correction, named due time and observation history intact.
  const beforeFailedReadback = await detail()
  for (const [patch, status] of [
   [null, 503],
   [{ account_sid: 'synthetic-handset-3101' }, 502],
   [{ phone_number: '+15125550126' }, 502],
   [{ port_in_request_sid: 'synthetic-handset-3102' }, 502],
   [{ phone_number_sid: 'synthetic-handset-3103' }, 502],
  ]) {
   if (patch) f.runtime.twilioResources.set(portUrl, { ...portReceipt, ...patch })
   else f.runtime.twilioResources.delete(portUrl)
   const refused = await post(f.runtime, `/api/handset/compliance/${port.id}/readback`, { revision: observed.revision, confirm: 'read exact compliance receipt' }, f.headers)
   assert.equal(refused.status, status, await refused.clone().text())
   assert.deepEqual(await detail(), beforeFailedReadback, 'failed receipt readback preserves the retained case and its due follow-up')
  }
  f.runtime.twilioResources.set(portUrl, portReceipt)
  const correctionNote = 'Named representative must correct the PIN privately and sign the exact-number LOA'
  const correction = await post(f.runtime, `/api/handset/compliance/${port.id}/review`, { revision: observed.revision, note: correctionNote, confirm: 'review exact correction preparation' }, f.headers)
  assert.equal(correction.status, 200)
  const corrected = await detail()
  assert.equal(corrected.case.approval_note, correctionNote)
  const staleReview = await post(f.runtime, `/api/handset/compliance/${port.id}/review`, { revision: observed.revision, note: 'synthetic-handset-3104 obsolete correction', confirm: 'review exact correction preparation' }, f.headers)
  assert.equal(staleReview.status, 409)
  assert.deepEqual(await detail(), corrected, 'an obsolete review cannot overwrite the current correction or append a review')
  await f.runtime.sql("UPDATE oa_operators SET role='member' WHERE id='synthetic-handset-2'")
  const member = await signIn({ ...f.runtime, ownerEmail: f.runtime.ownerEmail.replace('synthetic-handset-1', 'synthetic-handset-2') })
  const preparation = { sourceId: source.source.id, kind: 'port_pin', report: reports[0][1], dueAt, confirm: 'prepare exact compliance case' }
  const newPreparation = { ...preparation, report: { ...reports[0][1], port_in_request_sid: 'synthetic-handset-3105' } }
  const writes = [
   ['/api/handset/compliance', newPreparation],
   [`/api/handset/compliance/${port.id}/review`, { revision: corrected.case.revision, note: 'synthetic-handset-3106 unauthorized correction', confirm: 'review exact correction preparation' }],
   [`/api/handset/compliance/${port.id}/readback`, { revision: corrected.case.revision, confirm: 'read exact compliance receipt' }],
   [`/api/handset/compliance/${port.id}/submit`, { revision: corrected.case.revision }],
   [`/api/handset/compliance/${port.id}/follow-up`, { revision: corrected.case.revision, ownerId: 'synthetic-handset-1', dueAt: Date.now() + 3600000, nextAction: 'synthetic-handset-3107 unauthorized reassignment', confirm: 'assign exact continued follow-up' }],
  ]
  const beforeUnauthorized = await (await f.runtime.request('/api/handset/compliance', { headers: f.headers })).json()
  const beforeUnauthorizedRequests = f.runtime.sourceRequests.length
  for (const [headers, status] of [[{ cookie: member.cookie }, 403], [{}, 401], [{ authorization: 'Bearer ' + f.issued.token }, 401]]) {
   const refused = []
   for (const path of ['/api/handset/compliance', `/api/handset/compliance/${port.id}`]) refused.push(await f.runtime.request(path, { headers }))
   for (const [path, input] of writes) refused.push(await post(f.runtime, path, input, headers))
   for (const response of refused) {
    assert.equal(response.status, status)
    const body = await response.text()
    for (const privateValue of [port.id, source.source.id, port.reference, port.plan, corrected.case.approval_note]) assert.ok(!body.includes(privateValue), 'direct unauthorized compliance transport discloses no case evidence')
   }
   assert.deepEqual(await detail(), corrected)
   assert.deepEqual(await (await f.runtime.request('/api/handset/compliance', { headers: f.headers })).json(), beforeUnauthorized, 'unauthorized writes neither alter cases nor create a new one')
  }
  assert.equal(f.runtime.sourceRequests.length, beforeUnauthorizedRequests, 'unauthorized readback never reaches the provider')
  for(const [kind,path,receipt] of [
   ['brand_registration','https://messaging.twilio.com/v1/a2p/BrandRegistrations',{sid:'synthetic-handset-brand-1',account_sid:source.account,status:'APPROVED',customer_profile_bundle_sid:'synthetic-handset-private-profile'}],
   ['tollfree_verification','https://messaging.twilio.com/v1/Tollfree/Verifications',{sid:'synthetic-handset-tfv-1',account_sid:source.account,tollfree_phone_number:'+15125550125',status:'TWILIO_APPROVED',business_contact_email:'synthetic-handset-private@example.test'}],
  ]){
   const row=cases.find(r=>r.kind===kind),url=path+'/'+receipt.sid
   const read=()=>post(f.runtime,`/api/handset/compliance/${row.id}/readback`,{revision:row.revision,confirm:'read exact compliance receipt'},f.headers)
   f.runtime.twilioResources.set(url,{...receipt,sid:'synthetic-handset-foreign'});assert.equal((await read()).status,502)
   f.runtime.twilioResources.set(url,{...receipt,account_sid:'synthetic-handset-foreign'});assert.equal((await read()).status,502)
   f.runtime.twilioResources.set(url,receipt)
   const r=await read();assert.equal(r.status,200,await r.clone().text());const seen=(await r.json()).case
   assert.equal(seen.status,'follow_up');assert.ok(!JSON.stringify(seen).includes('synthetic-handset-private'))
   const next={revision:seen.revision,ownerId:'synthetic-handset-1',dueAt:Date.now()+3600000,nextAction:'Review remaining receiving-carrier eligibility with the named representative',confirm:'assign exact continued follow-up'}
   assert.equal((await post(f.runtime,`/api/handset/compliance/${row.id}/follow-up`,{...next,ownerId:'synthetic-handset-2'},f.headers)).status,403)
   const followed=await post(f.runtime,`/api/handset/compliance/${row.id}/follow-up`,next,f.headers)
   assert.equal(followed.status,200);assert.equal((await followed.json()).case.due_at,next.dueAt)
   assert.equal((await post(f.runtime,`/api/handset/compliance/${row.id}/follow-up`,next,f.headers)).status,409)
   const history=await (await f.runtime.request('/api/handset/compliance/'+row.id,{headers:f.headers})).json()
   assert.equal(history.events.filter(e=>e.kind==='follow_up').length,1)
   assert.ok(history.events.some(e=>e.kind==='reviewed'&&e.actor_id==='synthetic-handset-1'))
   assert.equal(history.cleanCompliance,false);assert.equal(history.cleanReputation,false)
  }
  await f.runtime.restart()
  const all = await (await f.runtime.request('/api/handset/compliance', { headers: f.headers })).json()
  assert.equal(all.cases.length, 5); assert.equal(all.cleanCompliance, false); assert.equal(all.cleanReputation, false)
  assert.ok(all.cases.every(r => r.due_at >= dueAt && r.owner_id === 'synthetic-handset-1'))
  assert.equal(all.cases.filter(r=>r.due_at===dueAt).length,3);assert.equal(all.cases.filter(r=>r.due_at>dueAt).length,2)
  assert.equal((await post(f.runtime, '/api/handset/sources/revoke', { sourceId: source.source.id }, f.headers)).status, 200)
  const revokedSources = await (await f.runtime.request('/api/handset/sources', { headers: f.headers })).json()
  assert.equal(revokedSources.sources.find(s => s.id === source.source.id).status, 'revoked')
  const beforeRevoked = await detail(), beforeRevokedRequests = f.runtime.sourceRequests.length
  for (const [path, input] of [...writes.slice(1), ['/api/handset/compliance', newPreparation], ['/api/handset/compliance', preparation]]) {
   const response = await post(f.runtime, path, input, f.headers)
   assert.equal(response.status, 409)
   assert.equal((await response.json()).error, 'source_inactive', 'revocation prevents new work and preparation replay before effects')
  }
  assert.equal(f.runtime.sourceRequests.length, beforeRevokedRequests, 'revocation prevents even a provider receipt read')
  assert.deepEqual(await detail(), beforeRevoked)
  assert.deepEqual(await (await f.runtime.request('/api/handset/compliance', { headers: f.headers })).json(), all)
  assert.deepEqual(await (await f.runtime.request('/api/handset/sources', { headers: f.headers })).json(), revokedSources, 'replaying preparation cannot recreate source authority')
  await f.runtime.restart()
  assert.deepEqual(await detail(), beforeRevoked, 'revoked cases retain the correction, due time and evidence through restart')
  assert.deepEqual(await (await f.runtime.request('/api/handset/sources', { headers: f.headers })).json(), revokedSources)
  assert.equal(f.runtime.sourceRequests.filter(r => r.method !== 'GET').length, 0, 'no port, address, replacement number or rotation mutation')
 } finally { await f.runtime.close() }
})
