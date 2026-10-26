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
  const approval = await f.create('/api/handset/grants/approve', { grantId: issued.grant.id, state, expiresAt: Date.now() + 3600000, confirm: 'approve exact reviewed state' })
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

// Customer-care permission is distinct from source records and marketing.
test('Explicit caller permission produces one missed-call reply and owned task through signed provider doors', async()=>{
 const {consentFixture,oneReplyJourney}=await import('./helpers/handset-consent.mjs'),f=await consentFixture()
 try {
  await oneReplyJourney(f)
  const declined=await f.start(2),yes=await (await f.start(3)).decision('1'),no=await declined.decision('2')
  assert.equal(no.replaceAll(declined.call.id,'call'),yes.replace(/calls\/[0-9a-f-]+\//,'calls/call/'),'decline keeps the exact staff ringing instructions')
  await declined.missed();const timeout=await f.start(4);await timeout.decision(null);await timeout.missed()
  const stopped=await f.start(5);await stopped.decision('1');await f.stop(stopped);await stopped.missed()
  const unknown=await f.start(6,{identity:'No-TN-Validation'});await unknown.decision('1');await unknown.missed()
  const report=await f.get();assert.equal(f.receiver.sent.length,1);assert.equal(report.outcomes.length,5)
  assert.ok(report.texts.some(t=>t.reason==='recipient_STOP_or_DNC'));assert.ok(report.texts.some(t=>t.reason==='caller_identity_unclear'))
  assert.equal(report.permissions.filter(p=>p.state==='declined').length,2)
  assert.ok(report.permissions.every(p=>JSON.parse(p.event).marketingEnrollment===false))
  const recoveries=await f.get('/api/handset/recovery');assert.equal(recoveries.cases.length,5);assert.ok(recoveries.cases.every(c=>c.owner_id==='synthetic-handset-1'))
  assert.equal((await f.signed(f.configured.providerPath,stopped.fields,{signature:false})).status,403)
  assert.equal((await f.runtime.request(f.base)).status,401)
 } finally {await f.runtime.close()}
})

test('Current registration and recipient hours hold texts and uncertain creates never replay',async()=>{
 const {consentFixture}=await import('./helpers/handset-consent.mjs'),f=await consentFixture()
 try {
  f.registration.status='IN_REVIEW';const pending=await f.start(20);await pending.decision('1');await pending.missed()
  f.registration.status='TWILIO_APPROVED';const timezone=await f.start(21,{configureRecipient:false});await timezone.decision('1');await timezone.missed()
  const quiet=await f.start(22);await f.recipient(quiet.caller,'Asia/Tokyo');await quiet.decision('1');await quiet.missed()
  assert.equal(f.receiver.sent.length,0)
  const lost=await f.start(23);await lost.decision('1');f.receiver.drop=true;await lost.missed();await lost.missed();await f.runtime.restart();await f.runtime.scheduled()
  assert.equal(f.receiver.sent.length,1)
  const report=await f.get();assert.ok(report.texts.some(t=>t.reason==='tollfree_registration_not_approved'));assert.ok(report.texts.some(t=>t.reason==='recipient_timezone_unknown_or_expired'));assert.ok(report.texts.some(t=>t.reason==='recipient_quiet_hours'));assert.ok(report.texts.some(t=>t.state==='uncertain'))
 } finally {await f.runtime.close()}
})

test('A native human can attest a permitted same-call verbal moment but missing recording permission is refused',async()=>{
 const {consentFixture}=await import('./helpers/handset-consent.mjs'),f=await consentFixture()
 try {
  const call=await f.start(30),verbal={callId:call.call.id,transcriptId:'synthetic-handset-no-permission',segmentId:'synthetic-handset-moment',recordingPermissionId:'synthetic-handset-missing',confirm:'I heard explicit permission for one customer-care text about this call'}
  const denied=await post(f.runtime,f.base+'/verbal',verbal,f.source.headers)
  assert.equal(denied.status,403);assert.equal((await f.get()).permissions.length,0)
  const recordingPermission=await f.write(f.base+'/recording-permissions',{callId:call.call.id,evidence:'Mara verified the caller explicitly agreed to this recording before recording began.',confirm:'I verified participant permission before this recording'})
  const sid='synthetic-handset-verbal-recording';f.source.resource('Recordings',sid,{call_sid:call.sid,start_time:new Date().toUTCString(),status:'completed',duration:'30',channels:2})
  const recorded=await f.source.callback({RecordingSid:sid,CallSid:call.sid,RecordingStatus:'completed',From:'',To:''});assert.equal(recorded.status,200,await recorded.clone().text())
  const recordingId=(await recorded.json()).recordId,transcript=await f.write('/api/handset/transcripts',{recordingId,durationMs:30000,state:'supplied',segments:[{id:'synthetic-handset-moment',speaker:'Caller',language:'en',startMs:5000,endMs:9000,text:'Yes, you may send me one text about this missed call.',confidence:1}],confirm:'authorize supplied transcript for my exact identity'})
  const result=await f.write(f.base+'/verbal',{...verbal,transcriptId:transcript.transcriptId,recordingPermissionId:recordingPermission.id})
  const event=JSON.parse(result.permission.event);assert.equal(event.kind,'human_verbal');assert.equal(event.personId,'synthetic-handset-1');assert.equal(event.moment.startMs,5000);assert.equal(event.marketingEnrollment,false)
  await call.missed();assert.equal(f.receiver.sent.length,1)
  assert.equal((await post(f.runtime,f.base+'/verbal',{...verbal,transcriptId:transcript.transcriptId,recordingPermissionId:recordingPermission.id},{authorization:'Bearer synthetic-handset-model-assertion'})).status,401)
 } finally {await f.runtime.close()}
})
