import assert from 'node:assert/strict'
import { test } from 'node:test'
import { post, signIn } from './helpers/handset-auth.mjs'
import { receptionistFixture } from './helpers/handset-receptionist.mjs'
import { sourceFixture } from './helpers/handset-sources.mjs'
import { metricConfig } from './helpers/handset-metrics.mjs'
import { intakeFixture, intakeTime } from './helpers/handset-recovery-intake.mjs'

async function setup() {
 const f = await receptionistFixture({clockTime:Date.parse('2026-10-26T18:00:00Z')}), source = await sourceFixture(f.runtime)
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

test('Reviewed business hours admit one owned task from final carrier readback without granting contact or resetting human decisions',async()=>{
 const f=await intakeFixture()
 try {
  const unapproved=f.call(1);assert.equal((await unapproved.send()).status,200);assert.equal((await f.get()).cases.length,0)
  await f.runtime.setTime(intakeTime+1000)
  const approved=await f.approve();assert.equal(approved.policy.revision,1)
  const stale=await post(f.runtime,f.base+'/policies',{sourceId:f.source.source.id,revision:0,timezone:'UTC',hours:{weekly:[]},confirm:'approve owned missed-call intake'},f.source.headers)
  assert.equal(stale.status,409)
  const unauthorized=await post(f.runtime,f.base+'/policies',{sourceId:f.source.source.id,revision:1,timezone:'UTC',hours:{weekly:[]},confirm:'approve owned missed-call intake'},{authorization:'Bearer synthetic-handset-1001'})
  assert.equal(unauthorized.status,401)
  assert.equal((await post(f.runtime,'/auth/operator/status',{operatorId:'synthetic-handset-2',status:'active'},f.source.headers)).status,200)
  const member=await signIn({...f.runtime,ownerEmail:'synthetic-handset-2@example.test'}),memberHeaders={cookie:member.cookie}
  assert.equal((await post(f.runtime,f.base+'/policies',{sourceId:f.source.source.id,revision:1,timezone:'UTC',hours:{weekly:[]},confirm:'approve owned missed-call intake'},memberHeaders)).status,403)
  assert.equal((await post(f.runtime,f.base+'/policies/revoke',{sourceId:f.source.source.id,revision:1},memberHeaders)).status,403)
  assert.equal((await unapproved.send()).status,200);assert.equal((await f.get()).cases.length,0,'approval never backfills an older missed outcome')
  const call=f.call(2),response=await call.send();assert.equal(response.status,200,await response.clone().text())
  const observed=await response.json(),task=(await f.get()).cases[0]
  assert.equal(task.call_record_id,observed.recordId);assert.equal(task.owner_id,'synthetic-handset-1');assert.equal(task.state,'open')
  assert.equal(task.due_at,Date.parse(call.resource.end_time)+60000)
  const taken=await f.write(f.base+'/'+task.id+'/takeover',{revision:task.revision,note:'Mara is already handling this need'},200)
  await call.send();await f.runtime.restart();await call.send()
  let report=await f.get();assert.equal(report.cases.length,1);assert.deepEqual(Object.fromEntries(Object.keys(taken.recovery).map(k=>[k,report.cases[0][k]])),taken.recovery)
  const retry=f.call(3,{caller:call.caller});assert.equal((await retry.send()).status,200);assert.equal((await f.get()).cases.length,1)
  assert.equal((await f.get()).cases[0].state,'human')
  assert.deepEqual((await f.get()).cases[0].missedCalls.map(c=>c.callSid),[call.sid,retry.sid],'the current owner sees both missed calls')
  const declined=await f.write(f.base+'/'+task.id+'/decline',{revision:taken.recovery.revision,note:'Caller declined this need'},200)
  await f.runtime.setTime(intakeTime+1500)
  const later=f.call(30,{caller:call.caller});assert.equal((await later.send()).status,200)
  report=await f.get();const fresh=report.cases.find(r=>r.previous_id===task.id)
  assert.ok(fresh);assert.equal(fresh.case_id,task.case_id);assert.equal(fresh.state,'open');assert.equal(fresh.owner_id,task.owner_id)
  assert.equal(report.cases.find(r=>r.id===task.id).state,'declined')
  await later.send();await f.runtime.restart();await later.send();assert.equal((await f.get()).cases.length,2)
  // Close the new need so the rest of this journey still counts independent callers.
  await f.write(f.base+'/'+fresh.id+'/decline',{revision:fresh.revision,note:'Second need also declined'},200)
  const answered=f.call(4,{status:'completed'}),childSid='synthetic-handset-intake-staff'
  const child={sid:childSid,account_sid:f.source.account,parent_call_sid:answered.sid,direction:'outbound-dial',from:answered.caller,to:'+15125551099',status:'completed',duration:'20'}
  answered.children.calls.push(child);f.source.resource('Calls',childSid,child)
  assert.equal((await answered.send()).status,200);assert.equal((await f.get()).cases.length,2,'a completed staff conversation is not missed')
  const failed=f.call(5);f.runtime.twilioResources.delete(failed.url)
  assert.equal((await failed.send()).status,503);assert.equal((await f.get()).cases.length,2)
  f.runtime.twilioResources.set(failed.url,failed.resource)
  assert.equal((await failed.send()).status,200);assert.equal((await f.get()).cases.length,3,'a provider retry completes interrupted intake once')
  const race=f.call(6)
  f.runtime.twilioResources.set(race.url,async()=>{
   await f.write(f.base+'/policies/revoke',{sourceId:f.source.source.id,revision:1},200)
   return race.resource
  })
  assert.equal((await race.send()).status,409);assert.equal((await f.get()).cases.length,3,'revocation during readback fences task creation')
  const reapproved=await f.approve(2);assert.equal(reapproved.policy.revision,3)
  const stopped=f.call(7)
  await f.write('/api/handset/protection/stops',{numberId:f.source.numberId,recipient:stopped.caller,channel:'all',reason:'dnc',confirm:'record outbound consent stop'})
  assert.equal((await stopped.send()).status,200)
  assert.equal((await f.get()).cases.find(r=>r.recipient===stopped.caller).state,'stopped')
  await f.runtime.setTime(Date.parse('2026-10-26T22:00:00Z'))
  const closed=f.call(8);assert.equal((await closed.send()).status,200);assert.equal((await f.get()).cases.length,4,'the local closing boundary excludes intake')
  report=await f.get();assert.equal(report.intakePolicies.length,1);assert.equal(report.intakePolicies[0].revision,3)
  assert.equal((await f.get('/api/handset/consent')).permissions.length,0)
  assert.equal((await f.get('/api/handset/callbacks')).callbacks.length,0)
  await f.runtime.setTime(intakeTime+1400)
  // A genuinely later call is separately owned; the prior decision stays final.
  const delayed=f.call(11,{caller:call.caller})
  const final=(await f.get()).cases.find(r=>r.id===fresh.id)
  await f.runtime.setTime(intakeTime+2000)
  const freshCall=f.call(10,{caller:call.caller});assert.equal((await freshCall.send()).status,200)
  const needs=(await f.get()).cases.filter(r=>r.recipient===call.caller)
  assert.equal(needs.length,3);assert.deepEqual(needs.find(r=>r.id===fresh.id),final)
  const newNeed=needs.find(r=>r.id!==fresh.id&&r.id!==task.id)
  assert.equal(newNeed.state,'open');assert.equal(newNeed.owner_id,'synthetic-handset-1')
  assert.notEqual(newNeed.call_record_id,fresh.call_record_id)
  await f.runtime.restart();await call.send();await freshCall.send();await delayed.send()
  assert.equal((await f.get()).cases.length,5)
  const delayedHistory=(await f.get()).cases.find(r=>r.id===fresh.id)
  assert.deepEqual({...delayedHistory,missedCalls:final.missedCalls},final)
  assert.deepEqual(delayedHistory.missedCalls.slice(0,final.missedCalls.length),final.missedCalls)
  assert.equal(delayedHistory.missedCalls.at(-1).callSid,delayed.sid,'late evidence stays with its original closed need')
  assert.deepEqual((await f.get()).cases.find(r=>r.id===newNeed.id),newNeed,'a late old call cannot change the fresh need')
  const withdrawn=f.call(9)
  f.runtime.twilioResources.set(withdrawn.url,async()=>{
   await f.write('/api/handset/sources/revoke',{sourceId:f.source.source.id},200)
   return withdrawn.resource
  })
  assert.equal((await withdrawn.send()).status,409)
  assert.equal((await f.get()).cases.length,5,'source withdrawal during readback cannot create owned work')
  assert.equal(f.runtime.sourceRequests.filter(r=>r.method==='POST').length,0)
 }finally{await f.runtime.close()}
})

test('Final queue outcomes create owned missed-call work with retained place while failed staff offers alone create nothing',async()=>{
 const f=await intakeFixture()
 try {
  const {queueFixture,authorizeQueueMedia}=await import('./helpers/handset-queues.mjs')
  const q=await queueFixture(f.runtime,f.source.cookie),{edge,destinations}=await authorizeQueueMedia(q,f.source)
  await f.approve()
  const call=edge.resource(80,{parent_call_sid:null})
  let response=await edge.callback(call);assert.equal(response.status,200,await response.clone().text());assert.match(await response.text(),/<Dial/)
  let state=await q.read(),offer=state.offers[0],place=state.entries.find(r=>r.id===offer.entry_id)
  const child=edge.child(80,call,destinations[q.english],'no-answer')
  response=await edge.status(offer,child,{CallStatus:'no-answer'});assert.equal(response.status,204,await response.clone().text())
  assert.equal((await f.get()).cases.length,0,'the customer is still waiting after the first failed staff ring')
  edge.parent(call,{parent_call_sid:null,status:'completed',end_time:new Date().toUTCString(),duration:'0'})
  response=await edge.status(offer,child,{CallStatus:'no-answer'});assert.equal(response.status,204,await response.clone().text())
  let task=(await f.get()).cases[0]
  assert.equal(task.queue_entry_id,place.id);assert.equal(JSON.parse(task.queue_place).queued_at,place.queued_at);assert.equal(JSON.parse(task.queue_place).priority,place.priority)
  await edge.callback({...call,CallStatus:'completed'})
  response=await f.source.callback({...call,CallStatus:'completed',SequenceNumber:'1',Timestamp:new Date().toISOString()});assert.equal(response.status,200,await response.clone().text())
  assert.equal((await f.get()).cases.length,1,'queue and canonical doors share the same owned task')
  await q.presence(q.english,'away')
  const waiting=edge.resource(81,{parent_call_sid:null})
  response=await edge.callback(waiting);assert.equal(response.status,200,await response.clone().text())
  state=await q.read();place=state.entries.find(r=>r.id!==task.queue_entry_id)
  edge.parent(waiting,{parent_call_sid:null,status:'completed',end_time:new Date().toUTCString(),duration:'0'})
  response=await edge.callback({...waiting,CallStatus:'completed'});assert.equal(response.status,200,await response.clone().text())
  assert.equal((await f.get()).cases.length,2,'terminal queue callers without a live offer are also owned')
  assert.equal((await f.get()).cases.find(r=>r.recipient===waiting.From).queue_entry_id,place.id)
  await f.runtime.restart();await edge.callback({...waiting,CallStatus:'completed'})
  assert.equal((await f.get()).cases.length,2)
  assert.equal(f.runtime.sourceRequests.filter(r=>r.method==='POST').length,0)
 }finally{await f.runtime.close()}
})

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
  const reportStart=Date.now()-86400000,reportEnd=Date.now()+86400000
  await f.runtime.setTime(Date.now()+8*86400000)
  f.headers.cookie=(await signIn(f.runtime)).cookie
  const configResponse=await post(f.runtime,'/api/handset/metrics/config',metricConfig('*',0,{startAt:reportStart,endAt:reportEnd}),f.headers);assert.equal(configResponse.status,201)
  const analytics=(await (await f.runtime.request('/api/handset/metrics/live?queueId=*',{headers:f.headers})).json()).native
  assert.equal(analytics.recovery.cases,3);assert.equal(analytics.recovery.confirmed,1);assert.deepEqual(analytics.recovery.confirmedCaseIds,[calls[0].caseId]);assert.deepEqual([analytics.fcr.numerator,analytics.fcr.denominator,analytics.fcr.value],[1,3,1/3]);assert.deepEqual(analytics.fcr.resolvedCallIds,[calls[0].recordId])

  await f.runtime.setTime(reportStart+86400000);f.headers.cookie=(await signIn(f.runtime)).cookie
  declined = await f.action(declined, 'decline', { note: 'Customer explicitly declined the visit' })
  await f.create('/api/handset/recovery/policies',{sourceId:f.source.source.id,revision:0,timezone:'UTC',hours:{weekly:[{days:[1,2,3,4,5,6,7],startMinute:0,endMinute:1440}]},confirm:'approve owned missed-call intake'})
  const {intakeCall}=await import('./helpers/handset-recovery-intake.mjs')
  await f.runtime.setTime(Date.now()+1000)
  const returned=intakeCall(f.runtime,f.source,91,{caller:booked.recipient});assert.equal((await returned.send()).status,200)
  const again=(await (await f.runtime.request('/api/handset/recovery',{headers:f.headers})).json()).cases.find(r=>r.previous_id===booked.id)
  assert.ok(again);assert.equal(again.case_id,booked.case_id);assert.equal(again.owner_id,booked.owner_id);assert.equal(again.state,'open')
  assert.equal((await post(f.runtime,`/api/handset/recovery/${again.id}/resolve`,{revision:again.revision,outcomeId:opened.outcome.id},f.headers)).status,409,'a new need cannot borrow the booking that resolved the earlier need')
  assert.equal((await (await f.runtime.request('/api/handset/recovery',{headers:f.headers})).json()).cases.find(r=>r.id===booked.id).state,'resolved')
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
  await f.runtime.setTime(Date.now()+1000)
  const lastCall=intakeCall(f.runtime,f.source,13,{caller:booked.recipient}),lastResponse=await lastCall.send()
  assert.equal(lastResponse.status,200)
  const later=await lastResponse.json(),newNeed=await f.open(later,{},200)
  assert.equal(later.caseId,calls[0].caseId);assert.notEqual(newNeed.id,booked.id)
  const reused=await post(f.runtime,`/api/handset/recovery/${newNeed.id}/resolve`,{revision:newNeed.revision,outcomeId:opened.outcome.id},f.headers)
  assert.equal(reused.status,409,'a prior need booking cannot resolve new missed work in the same case')
  assert.equal((await f.open(calls[0],{},200)).id,booked.id,'old call replays stay on their resolved need')
  assert.equal((await (await f.runtime.request('/api/handset/recovery',{headers:f.headers})).json()).cases.find(r=>r.id===newNeed.id).state,'open')

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
 const {consentFixture,oneReplyJourney,ownedTaskWithinMinute}=await import('./helpers/handset-consent.mjs'),f=await consentFixture()
 try {
  await oneReplyJourney(f)
  { const isolated=await consentFixture();try {
  // The failed offer must be part of a complete independently read-back set.
  const guarded=await isolated.start(90);await guarded.decision('1')
  const legSid='synthetic-handset-leg-90',otherSid='synthetic-handset-other-staff-90'
  const leg={sid:legSid,account_sid:isolated.source.account,parent_call_sid:guarded.sid,from:isolated.business,to:isolated.staff,direction:'outbound-dial',status:'no-answer',end_time:new Date().toUTCString()}
  const other={...leg,sid:otherSid,status:'completed',duration:'20'}
  const listUrl=`https://api.twilio.com/2010-04-01/Accounts/${isolated.source.account}/Calls.json?ParentCallSid=${guarded.sid}&PageSize=100`
  isolated.source.resource('Calls',legSid,leg)
  const list={calls:[leg,other],next_page_uri:null};isolated.runtime.twilioResources.set(listUrl,list)
  const outcome=()=>isolated.signed(`/providers/twilio/consent/calls/${guarded.call.id}/outcome`,{...guarded.fields,DialCallSid:legSid,DialCallStatus:'no-answer'})
  const before=await isolated.get(),tasksBefore=(await isolated.get('/api/handset/recovery')).cases
  for(const [change,status,code] of [
   [()=>{list.next_page_uri='/next'},409,'recovery_staff_readback_incomplete'],
   [()=>{list.next_page_uri=null;list.calls=[other]},409,'recovery_staff_readback_incomplete'],
   [()=>{list.calls=[leg,leg]},409,'recovery_staff_readback_incomplete'],
   [()=>{list.calls=[leg,other];other.status='in-progress'},409,'recovery_staff_outcome_uncertain'],
   [()=>{other.status='completed';other.duration='unknown'},409,'recovery_staff_duration_required'],
   [()=>{other.duration='20'},409,'staff_conversation_not_missed'],
   [()=>{other.sid='synthetic-handset-wrong-readback'},502,'recovery_child_identity_mismatch'],
  ]) {
   change();isolated.source.resource('Calls',otherSid,other)
   // Keep the listed identity fixed while independently changing its resource.
   list.calls=list.calls.map(row=>row===other?{...other,sid:otherSid}:row)
   const refused=await outcome();assert.equal(refused.status,status,await refused.clone().text());assert.equal((await refused.json()).error,code)
   assert.deepEqual((await isolated.get('/api/handset/recovery')).cases,tasksBefore)
   const report=await isolated.get();assert.deepEqual(report.outcomes,before.outcomes);assert.deepEqual(report.texts,before.texts)
   assert.equal(isolated.receiver.sent.length,0,'an unsafe staff outcome never contacts the customer')
  }
  list.calls=[leg];await isolated.runtime.restart()
  assert.equal((await outcome()).status,200);await outcome()
  assert.equal(isolated.receiver.sent.length,1,'the complete unanswered set permits exactly one reply')
  const old=(await isolated.get('/api/handset/recovery')).cases[0]
  const declined=await isolated.write('/api/handset/recovery/'+old.id+'/decline',{revision:old.revision,note:'The customer declined the previous need'},200)
  await isolated.runtime.setTime(Date.now()+1000)
  const fresh=await isolated.start(91,{caller:guarded.caller});await fresh.decision('1');await fresh.missed()
  const distinct=(await isolated.get('/api/handset/recovery')).cases
  assert.equal(distinct.length,2)
  const oldSnapshot=distinct.find(r=>r.id===old.id)
  assert.deepEqual(oldSnapshot,{...old,...declined.recovery})
  assert.equal(distinct.find(r=>r.id!==old.id).previous_id,old.id)
  assert.equal(distinct.find(r=>r.id!==old.id).state,'open')
  await outcome();await fresh.missed();await isolated.runtime.restart();await outcome()
  assert.equal((await isolated.get('/api/handset/recovery')).cases.length,2)
  assert.equal(isolated.receiver.sent.length,2,'each explicitly consented new call permits one reply, never a replay')

  } finally {await isolated.runtime.close()} }
  const declined=await f.start(2),yes=await (await f.start(3)).decision('1'),no=await declined.decision('2')
  assert.equal(no.replaceAll(declined.call.id,'call'),yes.replace(/calls\/[0-9a-f-]+\//,'calls/call/'),'decline keeps the exact staff ringing instructions')
  const timeout=await f.start(4);await timeout.decision(null)
  const disconnected=await f.start(7)
  for(const call of [declined,timeout,disconnected]) {
   const sentBefore=f.receiver.sent.length,began=performance.now()
   if(call===disconnected) {
    const incomplete=await call.disconnect({nextPage:'/next-page'})
    assert.equal(incomplete.status,409,'incomplete child-leg readback cannot prove a pre-consent disconnect')
    assert.equal((await f.get()).outcomes.some(o=>o.call_id===call.call.id),false)
    assert.equal((await f.get('/api/handset/recovery')).cases.some(c=>c.case_id===call.canonical.caseId),false,'incomplete readback creates no task')
    const response=await call.disconnect()
    assert.equal(response.status,200,await response.clone().text())
   } else await call.missed()
   const report=await f.get(),outcome=await ownedTaskWithinMinute(f,call,report,began)
   assert.equal(outcome.text_id,null,'no consent produces callback work alone')
   assert.equal(f.receiver.sent.length,sentBefore,'decline timeout and pre-decision disconnect send no text')
   const permission=report.permissions.find(p=>p.call_id===call.call.id)
   assert.equal(permission.state,'declined');assert.equal(permission.purpose,'one_reply')
   const event=JSON.parse(permission.event)
   assert.equal(event.marketingEnrollment,false)
   assert.equal(event.kind,call===disconnected?'no_response':'dtmf')
   if(call===disconnected) {
    await f.runtime.restart();assert.equal((await call.disconnect()).status,200)
    assert.equal((await f.get()).outcomes.filter(o=>o.call_id===call.call.id).length,1,'terminal callback replay after restart keeps one task')
    assert.equal(f.receiver.sent.length,sentBefore)
   }
  }
  const stopped=await f.start(5);await stopped.decision('1');await f.stop(stopped);await stopped.missed()
  const unknown=await f.start(6,{identity:'No-TN-Validation'});await unknown.decision('1');await unknown.missed()
  const report=await f.get();assert.equal(f.receiver.sent.length,1);assert.equal(report.outcomes.length,6)
  assert.ok(report.texts.some(t=>t.reason==='recipient_STOP_or_DNC'));assert.ok(report.texts.some(t=>t.reason==='caller_identity_unclear'))
  assert.equal(report.permissions.filter(p=>p.state==='declined').length,3)
  assert.ok(report.permissions.every(p=>JSON.parse(p.event).marketingEnrollment===false))
  const recoveries=await f.get('/api/handset/recovery');assert.equal(recoveries.cases.length,6);assert.ok(recoveries.cases.every(c=>c.owner_id==='synthetic-handset-1'))
  assert.equal((await f.signed(f.configured.providerPath,stopped.fields,{signature:false})).status,403)
  assert.equal((await f.runtime.request(f.base)).status,401)
  const withdrawn=await f.start(8)
  await f.write(f.base+'/revoke',{policyId:f.configured.policy.id})
  assert.equal((await withdrawn.disconnect()).status,409,'withdrawn consent-policy authority cannot create task work')
  assert.equal((await f.get()).outcomes.some(o=>o.call_id===withdrawn.call.id),false)
  assert.equal((await f.get('/api/handset/recovery')).cases.length,6)
  assert.equal(f.receiver.sent.length,1)
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

test('Post-call IVR and separately consented SMS keep real ratings and reconcile delivery denominators',async()=>{
 const {consentFixture,surveyJourney,consentTime}=await import('./helpers/handset-consent.mjs'),f=await consentFixture()
 try {
  const {state}=await surveyJourney(f)
  assert.equal(state.invitations.filter(i=>i.rating!==null).length,2)
  await f.runtime.setTime(consentTime+8*86400000)
  const {signIn}=await import('./helpers/handset-auth.mjs');f.source.headers.cookie=(await signIn(f.runtime)).cookie
  const report=await f.get('/api/handset/surveys');assert.equal(report.denominators.noResponse,1);assert.equal(report.denominators.averageRating,3.5)
  const configured=await post(f.runtime,'/api/handset/metrics/config',metricConfig('*',0,{startAt:consentTime-86400000,endAt:consentTime+86400000}),f.source.headers);assert.equal(configured.status,201)
  const analytics=(await (await f.runtime.request('/api/handset/metrics/live?queueId=*',{headers:f.source.headers})).json()).native
  assert.equal(analytics.csat.responses,2);assert.equal(analytics.csat.mean,3.5);assert.equal(analytics.csat.eligibleDelivered,report.denominators.eligibleDelivered);assert.equal(analytics.csat.responseRate,2/report.denominators.eligibleDelivered)
  assert.match(analytics.csat.basis,/AI sentiment and silence are excluded/)

 } finally {await f.runtime.close()}
})

test('Queued inbox work and scoped connected attempts share durable STOP across two company numbers and preflight races',async()=>{
 const {openHandset}=await import('./helpers/handset-worker.mjs'),{messagesFixture,messageNow}=await import('./helpers/handset-messages.mjs')
 const runtime=await openHandset({twilio:true,clockTime:messageNow})
 try {
  const a=await messagesFixture(runtime),b=await messagesFixture(runtime,{business:'+18335550135'})
  await a.incoming('Please confirm the service window');await b.incoming('Please confirm the same service window')
  const first=await a.queued(),second=await b.queued()
  const native=await a.incoming('Customer-care only, please'),person=await a.write('/api/handset/records',{kind:'person',sourceId:'synthetic-handset-1850',occurredAt:messageNow,caseId:native.caseId,data:{name:'Jordan Lee'}})
  const issued=await a.write('/api/handset/mcp/consent',{name:'Connected-system customer-care check',definition:{scopes:['send'],tools:['message.send'],records:[native.caseId],numbers:[a.source.numberId],recipients:[person.record.id],budgetCents:0,policyRevision:'owner-only-v1'},expiresAt:messageNow+3600000,confirm:'approve scoped credential'})
  const state={operation:'message.send',caseId:native.caseId,caseVersion:1,numberId:a.source.numberId,recipients:[person.record.id],amountCents:0,flowRevision:'',policyRevision:'owner-only-v1',content:'Confirm the service window'}
  const approval=await a.write('/api/handset/grants/approve',{grantId:issued.grant.id,state,expiresAt:messageNow+3600000,confirm:'approve exact reviewed state'})
  const auth={authorization:'Bearer '+issued.token},check=()=>runtime.request('/api/handset/v1/cases/'+native.caseId+'/message-suppression',{headers:auth})
  assert.equal((await (await check()).json()).suppressed,false)
  const prepared=await post(runtime,'/api/handset/application/prepare',{state,approvalId:approval.id,idempotencyKey:'synthetic-handset-1851'},auth)
  assert.equal(prepared.status,202,await prepared.clone().text());const held=await prepared.json()
  await a.incoming('custom opt-out',{OptOutType:'STOP'})
  assert.equal((await (await check()).json()).suppressed,true)
  for(const f of [a,b]){
   const report=await f.get();assert.equal(report.jobs.filter(j=>[first.id,second.id].includes(j.id)&&j.state==='suppressed').length,2)
   assert.equal((await f.get('/suppression?recipient='+encodeURIComponent(a.recipient))).suppressed,true)
  }
  assert.equal((await post(runtime,'/api/handset/application/execute',{jobId:held.job.id,state},auth)).status,409)
  assert.equal((await post(runtime,'/api/handset/application/prepare',{state,approvalId:approval.id,idempotencyKey:'synthetic-handset-1852'},auth)).status,409)
  await runtime.restart();await runtime.scheduled(messageNow)
  assert.equal(a.receiver.sent.length+b.receiver.sent.length,0)
  assert.equal((await (await check()).json()).suppressed,true)
  assert.equal((await post(runtime,a.base+'/permissions',{recipient:a.recipient,purpose:'customer-care',evidence:'A call alone is not a new opt-in',expiresAt:messageNow+3600000,confirm:'I verified explicit permission for customer-care texts'},a.headers)).status,409)
  const other=await messagesFixture(runtime,{business:'+18335550145',recipient:'+15125550128'}),racing=await other.queued()
  const registrationUrl='https://messaging.twilio.com/v1/Tollfree/Verifications/'+other.registration.sid
  runtime.twilioResources.set(registrationUrl,async()=>{await other.incoming('STOP');return other.registration})
  const after=(await other.write('/jobs/'+racing.id+'/dispatch',{revision:racing.revision},200)).job
  assert.equal(after.state,'suppressed');assert.equal(other.receiver.sent.length,0,'STOP during provider preflight receives no POST')
  const foreign=await runtime.request('/api/handset/v1/cases/'+(await other.current()).id+'/message-suppression',{headers:auth})
  assert.equal(foreign.status,403)
  await a.write('/api/handset/grants/'+issued.grant.id+'/revoke',{},200)
  assert.equal((await check()).status,401,'current revocation fences the connected suppression check')
 }finally{await runtime.close()}
})

test('Assigned staff recovery capabilities isolate work and revocation returns ownership to the confirmed fallback',async()=>{
 const f=await setup()
 try {
  await post(f.runtime,'/auth/operator/status',{operatorId:'synthetic-handset-2',status:'active'},f.headers)
  await post(f.runtime,'/auth/operator/role',{operatorId:'synthetic-handset-2',role:'member'},f.headers)
  const member=await signIn({...f.runtime,ownerEmail:'synthetic-handset-2@example.test'}),headers={cookie:member.cookie}
  const person=(await f.runtime.sql("SELECT version FROM oa_operators WHERE id='synthetic-handset-2'")).results[0]
  const one=await f.open(await f.missed(70)),two=await f.open(await f.missed(71))
  const response=await post(f.runtime,'/api/handset/recovery/access',{personId:'synthetic-handset-2',personVersion:person.version,numberId:f.source.numberId,capabilities:['read','work','takeover','stop','decline','schedule','cancel'],fallbackId:'synthetic-handset-1',expiresAt:Date.now()+3600000,confirm:'approve scoped recovery work'},f.headers)
  assert.equal(response.status,201,await response.clone().text());const {grant}=await response.json()
  let assigned=await f.action(one,'assign',{ownerId:'synthetic-handset-2',note:'Assigned to reception'})
  let list=await f.runtime.request('/api/handset/recovery',{headers});assert.equal(list.status,200);assert.deepEqual((await list.json()).cases.map(r=>r.id),[one.id])
  assert.equal((await post(f.runtime,`/api/handset/recovery/${two.id}/takeover`,{revision:two.revision,note:'Outside assigned scope'},headers)).status,403)
  assert.equal((await post(f.runtime,`/api/handset/recovery/${assigned.id}/assign`,{revision:assigned.revision,ownerId:'synthetic-handset-1',note:'Broaden my assignment'},headers)).status,403)
  assert.equal((await post(f.runtime,'/api/handset/recovery/access',{...grant},headers)).status,403)
  assert.equal((await post(f.runtime,'/api/handset/recovery/policies',{},headers)).status,403)
  const taken=await post(f.runtime,`/api/handset/recovery/${assigned.id}/takeover`,{revision:assigned.revision,note:'I am helping this caller'},headers)
  assert.equal(taken.status,200);assigned=(await taken.json()).recovery;assert.equal(assigned.state,'human')
  await f.create('/api/handset/recovery/policies',{sourceId:f.source.source.id,revision:0,timezone:'UTC',hours:{weekly:[{days:[1,2,3,4,5,6,7],startMinute:0,endMinute:1440}]},confirm:'approve owned missed-call intake'})
  const {intakeCall}=await import('./helpers/handset-recovery-intake.mjs'),later=intakeCall(f.runtime,f.source,95,{caller:assigned.recipient})
  assert.equal((await later.send()).status,200)
  const current=(await (await f.runtime.request('/api/handset/recovery',{headers})).json()).cases[0]
  assert.equal(current.owner_id,'synthetic-handset-2');assert.equal(current.state,'human');assert.equal(current.missedCalls[0].callSid,later.sid,'later missed work reaches the assigned staff member, not the intake approver')
  assert.equal((await post(f.runtime,'/auth/invite',{email:'synthetic-handset-3@example.test',displayName:'Rosa',role:'member'},f.headers)).status,202)
  const other=await signIn({...f.runtime,ownerEmail:'synthetic-handset-3@example.test'}),otherHeaders={cookie:other.cookie}
  const operators=await (await f.runtime.request('/auth/operators',{headers:f.headers})).json(),person3=operators.find(p=>p.email==='synthetic-handset-3@example.test')
  const grant3=await post(f.runtime,'/api/handset/recovery/access',{personId:person3.id,personVersion:person3.version,numberId:f.source.numberId,capabilities:['read','work','takeover','decline'],fallbackId:'synthetic-handset-1',expiresAt:Date.now()+3600000,confirm:'approve scoped recovery work'},f.headers)
  assert.equal(grant3.status,201,await grant3.clone().text())
  const assigned3=await f.action(two,'assign',{ownerId:person3.id,note:'Separate staff assignment'})
  const own3=await f.runtime.request('/api/handset/recovery',{headers:otherHeaders});assert.equal(own3.status,200);assert.deepEqual((await own3.json()).cases.map(r=>r.id),[two.id])
  assert.equal((await post(f.runtime,`/api/handset/recovery/${one.id}/takeover`,{revision:current.revision,note:'Outside second staff scope'},otherHeaders)).status,403)
  assert.equal((await post(f.runtime,`/api/handset/recovery/${two.id}/takeover`,{revision:assigned3.revision,note:'Second staff works their own need'},otherHeaders)).status,200)
  const revoked=await post(f.runtime,'/api/handset/recovery/access/revoke',{accessId:grant.id,fallbackId:'synthetic-handset-1',confirm:'confirm recovery fallback'},f.headers)
  assert.equal(revoked.status,200)
  assert.equal((await f.runtime.request('/api/handset/recovery',{headers})).status,403)
  assert.equal((await post(f.runtime,`/api/handset/recovery/${assigned.id}/decline`,{revision:assigned.revision,note:'No longer authorized'},headers)).status,403)
  const report=await (await f.runtime.request('/api/handset/recovery',{headers:f.headers})).json(),fallback=report.cases.find(r=>r.id===one.id)
  assert.equal(fallback.owner_id,'synthetic-handset-1');assert.equal(fallback.state,'human');assert.match(fallback.reason,/fallback/)
  assert.equal(f.runtime.sourceRequests.filter(r=>r.method==='POST').length,0)
 }finally{await f.runtime.close()}
})
