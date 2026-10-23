import assert from 'node:assert/strict'
import { test } from 'node:test'
import { post } from './helpers/handset-auth.mjs'
import { receptionistFixture } from './helpers/handset-receptionist.mjs'
import { sourceFixture } from './helpers/handset-sources.mjs'

async function setup() {
 const f = await receptionistFixture(), source = await sourceFixture(f.runtime)
 const missed = async (n, peer = n) => {
  const response = await source.callback({ From: `+1512555${String(1000 + peer)}`, CallSid: `synthetic-handset-missed-${n}`, CallStatus: 'no-answer', SequenceNumber: '0', Timestamp: new Date().toISOString() })
  assert.equal(response.status, 200, await response.clone().text()); return response.json()
 }
 const open = async (call, extra = {}, status = 201) => (await f.create('/api/handset/recovery', { callRecordId: call.recordId, dueAt: Date.now() + 3600000, maxAttempts: 2, ...extra }, f.headers, status)).recovery
 const action = async (row, op, input = {}) => {
  const response = await post(f.runtime, `/api/handset/recovery/${row.id}/${op}`, { revision: row.revision, ...input }, f.headers)
  assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).recovery
 }
 return { ...f, source, missed, open, action }
}

test('Verified missed legs correlate to one recovery need and retain their queue place while opt-outs suppress contact', async () => {
 const f = await setup()
 try {
  const first = await f.missed(1), next = await f.missed(2, 1)
  assert.equal(first.caseId, next.caseId)
  const q = await f.create('/api/handset/queues', { name: 'Austin estimates / Presupuestos', mode: 'longest_idle', skills: [], maxWaitSeconds: 86400, wrapSeconds: 30, maxWaiting: 100, overflowKind: 'voicemail', confirm: 'approve native queue policy' })
  const entry = (await f.create(`/api/handset/queues/${q.id}/entries`, { callId: first.recordId, language: 'en', skills: [], priority: 4 })).entry
  let recovery = await f.open(first, { queueEntryId: entry.id })
  const replay = await f.open(next, {}, 200)
  assert.equal(replay.id, recovery.id)
  const place = JSON.parse(recovery.queue_place)
  assert.equal(place.queued_at, entry.queued_at); assert.equal(place.priority, 4); assert.equal(place.id, entry.id)
  recovery = await f.action(recovery, 'takeover', { note: 'Mara is handling this caller now' })
  const denied = await post(f.runtime, `/api/handset/recovery/${recovery.id}/callback-proposal`, { revision: recovery.revision, timezone: 'America/Chicago', dueAt: Date.now() + 1000 }, f.headers)
  assert.equal(denied.status, 409)
  assert.equal(f.runtime.sourceRequests.filter(r => r.method === 'POST').length, 0, 'human takeover never dials')
  await f.create('/api/handset/protection/stops', { numberId: f.source.numberId, recipient: '+15125551003', channel: 'all', reason: 'dnc', confirm: 'record outbound consent stop' })
  const opted = await f.open(await f.missed(3))
  assert.equal(opted.state, 'stopped'); assert.match(opted.reason, /opt-out|DNC/)
  assert.equal((await f.runtime.request('/api/handset/recovery')).status, 401)
  assert.equal((await post(f.runtime, '/api/handset/recovery', {}, { authorization: 'Bearer ' + f.issued.token })).status, 401)
  await f.runtime.restart()
  const rows = await (await f.runtime.request('/api/handset/recovery', { headers: f.headers })).json()
  assert.equal(rows.cases.length, 2); assert.equal(rows.cases.find(r => r.id === recovery.id).queue_place, recovery.queue_place)
 } finally { await f.runtime.close() }
})

test('Recovery closes only on a same-case confirmed booking or explicit decline and overdue work stays owned after restart', async () => {
 const f = await setup()
 try {
  const calls = await Promise.all([f.missed(10), f.missed(11), f.missed(12)])
  let [booked, declined, unreachable] = await Promise.all(calls.map(c => f.open(c)))
  const invalid = await post(f.runtime, `/api/handset/recovery/${booked.id}/resolve`, { revision: booked.revision, outcomeId: 'synthetic-handset-no-booking' }, f.headers)
  assert.equal(invalid.status, 409)
  await f.savePolicy()
  const issued = await f.create('/api/handset/mcp/consent', { name: 'Recovery booking worker', definition: { scopes: ['send'], tools: ['outcome.work'], records: calls.map(c => c.caseId), numbers: [], recipients: [], budgetCents: 0, policyRevision: 'owner-only-v1' }, expiresAt: Date.now() + 3600000, confirm: 'approve scoped credential' })
  const agent = async (path, value, status = 200) => {
   const response = await f.agent(path, value, issued.token); assert.equal(response.status, status, await response.clone().text()); return response.json()
  }
  const opened = await agent('outcomes', { callId: 'synthetic-handset-recovered-10', caseId: calls[0].caseId, language: 'en', callerName: 'Jordan Lee', callerEmail: 'synthetic-handset-10@example.test', identityBasis: 'callback_to_number_on_file', identityVerified: true }, 201)
  f.edges.slots.push(new Date(Date.now() + 86400000).toISOString())
  const prefix = `outcomes/${opened.outcome.id}/`
  await agent(prefix + 'availability', { serviceId: 'furnace' })
  const booking = await agent(prefix + 'booking', { serviceId: 'furnace', startAt: f.edges.slots[0] })
  assert.equal(booking.step.state, 'confirmed'); assert.equal(f.edges.bookings.size, 1)
  assert.equal((await post(f.runtime, `/api/handset/recovery/${declined.id}/resolve`, { revision: declined.revision, outcomeId: opened.outcome.id }, f.headers)).status, 409, 'another customer cannot borrow the booking')
  booked = await f.action(booked, 'resolve', { outcomeId: opened.outcome.id }); assert.equal(booked.state, 'resolved')
  declined = await f.action(declined, 'decline', { note: 'Customer explicitly declined the visit' })
  unreachable = await f.action(unreachable, 'callback-proposal', { timezone: 'America/Chicago', dueAt: Date.now() - 1000 })
  assert.match(unreachable.reason, /No dial started/)
  await f.runtime.restart(); await f.runtime.scheduled()
  const rows = await (await f.runtime.request('/api/handset/recovery', { headers: f.headers })).json()
  assert.equal(rows.cases.find(r => r.id === booked.id).state, 'resolved')
  assert.equal(rows.cases.find(r => r.id === declined.id).state, 'declined')
  const overdue = rows.cases.find(r => r.id === unreachable.id)
  assert.equal(overdue.state, 'escalated'); assert.equal(overdue.owner_id, 'synthetic-handset-1'); assert.match(overdue.reason, /named owner/)
  assert.equal(f.runtime.sourceRequests.filter(r => r.method === 'POST').length, 0)
  await f.runtime.scheduled()
  assert.equal((await f.runtime.sql("SELECT count(*) AS n FROM hnd_recovery_events WHERE recovery_id=? AND kind='overdue'", unreachable.id)).results[0].n, 1)
 } finally { await f.runtime.close() }
})


test('Continuity assessment separates media from API health, cites connector and USD risks, and never applies an unqualified fix', async () => {
 const f = await setup()
 try {
  await f.savePolicy()
  const missed = await f.missed(30)
  await f.open(missed, { dueAt: Date.now() - 1000 })
  f.runtime.twilioResources.set('https://insights.twilio.com/v1/Voice/synthetic-handset-missed-30/Summary', { account_sid: f.source.account, call_sid: 'synthetic-handset-missed-30', call_type: 'sip', call_state: 'completed', processing_state: 'complete', tags: ['high_jitter','high_packet_loss'] })
  f.edges.orbitExpired = true
  // Reserve a real scoped budget through the native approval and application doors.
  const person = await f.create('/api/handset/records', { kind: 'person', sourceId: 'synthetic-handset-ops-person', occurredAt: Date.now(), data: { name: 'Jordan Lee' } })
  const issued = await f.create('/api/handset/mcp/consent', { name: 'Approved callback budget', definition: { scopes: ['send'], tools: ['call.paid'], records: [missed.caseId], numbers: [f.source.numberId], recipients: [person.record.id], budgetCents: 10000, policyRevision: 'owner-only-v1' }, expiresAt: Date.now() + 3600000, confirm: 'approve scoped credential' })
  const state = { operation: 'call.paid', caseId: missed.caseId, caseVersion: 1, numberId: f.source.numberId, recipients: [person.record.id], amountCents: 9000, flowRevision: '', policyRevision: 'owner-only-v1', content: 'Reviewed callback reservation' }
  const approval = await f.create('/api/handset/approvals', { grantId: issued.grant.id, state, expiresAt: Date.now() + 3600000, confirm: 'approve exact reviewed state' })
  const reserved = await post(f.runtime, '/api/handset/application/prepare', { state, approvalId: approval.id, idempotencyKey: 'synthetic-handset-ops-reservation' }, { authorization: 'Bearer ' + issued.token })
  assert.equal(reserved.status, 202, await reserved.clone().text())
  const assessed = await f.create('/api/handset/operations/assess', { callRecordId: missed.recordId })
  assert.match(assessed.snapshot.api, /media health is independently observed/)
  assert.deepEqual(assessed.snapshot.risks.map(r => r.kind), ['media','connector','usd_cap','callbacks'])
  assert.equal(assessed.snapshot.connector, 'scope_or_oauth_refused')
  assert.equal(assessed.snapshot.nearCaps[0].reserved_cents, 9000)
  assert.equal(assessed.snapshot.proposalTest, 'not_run')
  const decision = await post(f.runtime, `/api/handset/operations/${assessed.id}/decision`, { revision: assessed.revision, decision: 'approved', note: 'Review media route and reconnect CRM; retain callback owner', confirm: 'record exact continuity decision' }, f.headers)
  assert.equal(decision.status, 200); assert.equal((await decision.json()).applied, false)
  await f.runtime.restart()
  const exported = await (await f.runtime.request(`/api/handset/operations/${assessed.id}/export`, { headers: f.headers })).json()
  assert.equal(exported.pendingCallbackCount, 1); assert.match(exported.receiver, /pending/)
  assert.ok(!JSON.stringify(exported).includes('+1512') && !JSON.stringify(exported).includes('synthetic-handset-500'))
  assert.equal(f.runtime.sourceRequests.filter(r => r.method !== 'GET').length, 0)
  // A provider response for another account cannot become evidence for this leg.
  f.runtime.twilioResources.set('https://insights.twilio.com/v1/Voice/synthetic-handset-missed-30/Summary', { account_sid: 'synthetic-handset-foreign', call_sid: 'synthetic-handset-missed-30', tags: [] })
  assert.equal((await post(f.runtime, '/api/handset/operations/assess', { callRecordId: missed.recordId }, f.headers)).status, 502)
 } finally { await f.runtime.close() }
})
