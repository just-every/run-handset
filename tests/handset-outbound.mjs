import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'
import { protectionFixture } from './helpers/handset-protection.mjs'
import { screeningJourney } from './helpers/handset-screening.mjs'

// Provider payload/verb contracts: https://www.twilio.com/docs/voice/twiml
// https://www.twilio.com/docs/voice/api/sending-sip
// https://www.twilio.com/docs/usage/security
// All network-edge identities and numbers below are controlled synthetic fixtures.
test('Owner console policies block voice and native fax, allow exceptions, preserve personal precedence and exempt designated callbacks',async()=>{
 const runtime=await openHandset({twilio:true})
 try{
  const f=await protectionFixture(runtime)
  const form=new URLSearchParams({scope:'owner',numberId:f.numberId,channel:'all',matchKind:'prefix',pattern:'+1512555',effect:'block',confirm:'apply nuisance policy'})
  const applied=await runtime.request('/app/protection/rules',{method:'POST',headers:{cookie:f.cookie,origin:runtime.origin,'content-type':'application/x-www-form-urlencoded'},body:form.toString()})
  assert.equal(applied.status,200,await applied.clone().text())
  const block=(await f.overview()).rules[0]
  const refused=await f.carrier();assert.equal(refused.status,200);assert.match(await refused.text(),/<Response><Reject reason="rejected"\/><\/Response>/)
  assert.equal((await f.check({channel:'fax',eventKey:'synthetic-handset-610'})).decision,'block','native fax admission follows the fax rule')
  await f.rule({matchKind:'number',pattern:'+15125550126',effect:'allow'})
  const allowed=await f.carrier({CallSid:'synthetic-handset-611',From:'+15125550126'})
  assert.equal(allowed.status,200);assert.ok((await allowed.text()).includes(f.continuation))
  assert.equal((await f.check({channel:'fax',address:'+15125550126',eventKey:'synthetic-handset-612'})).decision,'allow')
  await f.rule({matchKind:'anonymous',pattern:'',channel:'voice'})
  assert.match(await (await f.carrier({CallSid:'synthetic-handset-613',From:'anonymous'})).text(),/<Reject /)
  await f.rule({scope:'personal',personalId:'synthetic-handset-1',matchKind:'number',pattern:'+15125550127',effect:'allow'})
  assert.equal((await f.check({personalId:'synthetic-handset-1',eventKey:'synthetic-handset-614'})).decision,'block','owner block precedes personal exception')
  await f.write('callbacks',{numberId:f.numberId,caller:'+15125550127',expiresAt:Date.now()+3600000,confirm:'designate emergency callback'})
  // Retry of the same carrier call must recheck a newly designated emergency callback.
  assert.ok((await (await f.carrier()).text()).includes(f.continuation))
  const emergencyCheck=await f.check({eventKey:'synthetic-handset-615'})
  assert.equal(emergencyCheck.decision,'exempt');assert.equal(emergencyCheck.reason,'designated_emergency_callback')
  await f.write('stops',{numberId:f.numberId,recipient:'+15125550126',channel:'all',reason:'dnc',confirm:'record outbound consent stop'})
  const dnc=await f.check({direction:'outbound',address:'+15125550126',eventKey:'synthetic-handset-616'})
  assert.equal(dnc.reason,'dnc');assert.equal(dnc.decision,'block','inbound allow never supplies consent')
  await f.write('revoke',{ruleId:block.id},200)
  assert.equal((await f.check({address:'+15125550129',eventKey:'synthetic-handset-617'})).decision,'allow')
  await f.rule({matchKind:'prefix',pattern:'+1212',effect:'allow'})
  await f.rule({matchKind:'number',pattern:'+12125550140',effect:'block'})
  assert.equal((await f.check({address:'+12125550140',eventKey:'synthetic-handset-680'})).decision,'block','exact block beats a broader owner allow')
  await f.rule({scope:'personal',personalId:'synthetic-handset-1',matchKind:'number',pattern:'+12125550141',effect:'block'})
  assert.equal((await f.check({address:'+12125550141',personalId:'synthetic-handset-1',eventKey:'synthetic-handset-681'})).decision,'block','owner allow does not remove this person’s block')
  assert.equal((await f.check({address:'+12125550141',eventKey:'synthetic-handset-682'})).decision,'allow','personal block does not bind another recipient')
  const standing=await f.write('callbacks',{numberId:f.numberId,caller:'+12125550140',expiresAt:Date.now()+3*86400000,confirm:'designate emergency callback'})
  await runtime.sql('UPDATE hnd_protection_callbacks SET created_at=created_at-? WHERE id=?',2*86400000,standing.id)
  assert.equal((await f.check({address:'+12125550140',eventKey:'synthetic-handset-683'})).decision,'exempt','standing designation remains valid after more than 24 hours')
  await f.check({direction:'outbound',address:'911',eventKey:'synthetic-handset-687'})
  assert.equal((await runtime.sql('SELECT count(*) AS n FROM hnd_protection_emergency_windows')).results[0].n,0,'a console policy simulation opens no emergency-callback authority')
  const history=await runtime.request('/api/handset/audit/export',{headers:f.headers}),rows=(await history.json()).rows
  assert.ok(rows.some(r=>r.action==='protection.rule'&&r.subject===block.id))
  assert.ok(rows.some(r=>r.action==='protection.revoke'&&r.subject===block.id))
  const policies=rows.filter(r=>r.action==='protection.admit').map(r=>JSON.parse(r.policy).applied)
  assert.ok(policies.some(p=>p.source?.id===f.source.id&&p.source.revision===f.source.revision&&p.rule?.id===block.id),'carrier admission retains its actual source revision and selected immutable rule')
  const native=(await runtime.sql('SELECT version FROM oa_operators WHERE id=?','synthetic-handset-1')).results[0]
  assert.ok(policies.some(p=>p.native?.role==='owner'&&p.native.version===native.version),'native policy checks retain the acting owner authority version')
 }finally{await runtime.close()}
})

test('Signed compromised-device burst is contained before any paid instruction while the normal customer case and direct emergency route continue',async()=>{
 const runtime=await openHandset({twilio:true})
 try{
  const f=await protectionFixture(runtime)
  const incoming=await f.callback({CallSid:'synthetic-handset-620',CallStatus:'completed',Timestamp:new Date().toISOString()})
  assert.equal(incoming.status,200);const {caseId}=await incoming.json()
  const before=await (await runtime.request('/api/handset/cases/'+caseId,{headers:f.headers})).json()
  const device={From:'sip:synthetic-handset-621@synthetic-handset-622.example.test',SipUsername:'synthetic-handset-621',To:'sip:+442079460123@synthetic-handset-622.example.test'}
  // Concurrent official-schema INVITEs exercise the actual emitted Worker and D1.
  const responses=await Promise.all(Array.from({length:6},(_,i)=>f.carrier({...device,CallSid:`synthetic-handset-${630+i}`})))
  for(const r of responses){assert.equal(r.status,200,await r.clone().text());const xml=await r.text();assert.match(xml,/<Reject /);assert.doesNotMatch(xml,/<Dial|<Message|<Redirect/)}
  const state=await f.overview()
  assert.ok(state.alerts.some(a=>a.device_id.endsWith('synthetic-handset-621')&&a.containment==='device_outbound_blocked'))
  assert.equal(state.attempts.filter(a=>a.direction==='outbound').length,6)
  assert.equal(state.attempts.filter(a=>a.direction==='outbound').reduce((n,a)=>n+a.attempted_cents,0),600)
  assert.ok(state.attempts.every(a=>a.direction!=='outbound'||a.decision==='block'))
  assert.ok(state.attempts.every(a=>a.direction!=='outbound'||a.principal===f.source.id),'containment retains the signed source attribution')
  const visible=await runtime.request('/app/protection',{headers:f.headers});assert.equal(visible.status,200);assert.match(await visible.text(),/device_outbound_blocked/)
  const emergency=await f.carrier({...device,CallSid:'synthetic-handset-636',To:'sip:911@synthetic-handset-622.example.test'})
  assert.equal(emergency.status,200);const emergencyXml=await emergency.text();assert.ok(emergencyXml.includes(f.emergency));assert.doesNotMatch(emergencyXml,/<Reject|<Dial/)
  await f.rule({matchKind:'anonymous',pattern:'',channel:'voice',effect:'block'})
  const callback=await f.carrier({CallSid:'synthetic-handset-684',From:'restricted'})
  assert.equal(callback.status,200);assert.ok((await callback.text()).includes(f.continuation),'restricted dispatch-centre callback bypasses anonymous block inside post-911 window')
  let window=(await runtime.sql('SELECT * FROM hnd_protection_emergency_windows WHERE number_id=?',f.numberId)).results[0]
  assert.ok(window.expires_at-window.opened_at>=3600000)
  await f.carrier({...device,CallSid:'synthetic-handset-636',To:'sip:911@synthetic-handset-622.example.test'})
  assert.equal((await runtime.sql('SELECT expires_at FROM hnd_protection_emergency_windows WHERE number_id=?',f.numberId)).results[0].expires_at,window.expires_at,'same emergency attempt does not renew the callback clock')
  await runtime.sql('UPDATE hnd_protection_emergency_windows SET expires_at=? WHERE number_id=?',Date.now()-1,f.numberId)
  assert.match(await (await f.carrier({CallSid:'synthetic-handset-685',From:'restricted'})).text(),/<Reject /)
  await f.write('callback-window',{numberId:f.numberId,minutes:120,confirm:'set post-911 callback window'},200)
  await f.carrier({...device,CallSid:'synthetic-handset-686',To:'sip:911@synthetic-handset-622.example.test'})
  window=(await runtime.sql('SELECT * FROM hnd_protection_emergency_windows WHERE number_id=?',f.numberId)).results[0]
  assert.ok(window.expires_at-window.opened_at>=7200000,'owner may lengthen future windows')
  const normal=await f.carrier({CallSid:'synthetic-handset-637',From:'+15125550126'})
  assert.equal(normal.status,200);assert.ok((await normal.text()).includes(f.continuation))
  const after=await (await runtime.request('/api/handset/cases/'+caseId,{headers:f.headers})).json()
  assert.deepEqual(after,before,'protection evidence does not corrupt existing customer work')
  assert.equal((await runtime.sql('SELECT count(*) AS n FROM hnd_jobs')).results[0].n,0)
  assert.ok(runtime.sourceRequests.every(r=>r.method==='GET'),'no outbound provider creation request')
  const alert=state.alerts[0]
  await f.write('acknowledge',{alertId:alert.id},200)
  assert.equal((await f.overview()).alerts.find(a=>a.id===alert.id).released_at,null,'acknowledging does not release containment')
  const audit=(await (await runtime.request('/api/handset/audit/export',{headers:f.headers})).json()).rows
  assert.ok(audit.some(r=>r.action==='protection.contain'&&r.actor===f.source.id&&r.outcome==='refused'))
 }finally{await runtime.close()}
})

test('Private policy administration rejects borrowed authority, forged carrier ingress and consent overrides; SMS and registration attacks remain contained',async()=>{
 const runtime=await openHandset({twilio:true})
 try{
  const f=await protectionFixture(runtime)
  assert.equal((await runtime.request('/api/handset/protection')).status,401)
  assert.equal((await f.carrier({}, {signature:false})).status,403)
  assert.equal((await f.carrier({}, {suffix:'&To=%2B15125550199'})).status,403)
  assert.equal((await f.carrier({To:'+15125550199'})).status,403)
  assert.equal((await post(runtime,'/api/handset/protection/check',{numberId:f.numberId,address:'+15125550126',channel:'voice',direction:'outbound',deviceId:'synthetic-handset-640',eventKey:'synthetic-handset-641',authorized:true,consent:true},f.headers)).status,400)
  await runtime.sql('UPDATE oa_operators SET status=?,role=? WHERE id=?','active','admin','synthetic-handset-2')
  const {cookie}=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  assert.equal((await post(runtime,'/api/handset/protection/rules',{scope:'owner',channel:'all',matchKind:'anonymous',effect:'allow',confirm:'apply nuisance policy'},{cookie})).status,403)
  for(const [channel,direction,fixtureId] of [['sms','outbound',650],['sip','registration',660]]){
   const answers=[]
   for(let n=0;n<3;n++)answers.push(await f.check({channel,direction,address:'+15125550126',deviceId:`synthetic-handset-${fixtureId}`,eventKey:`synthetic-handset-${fixtureId+1+n}`}))
   assert.ok(answers.every(a=>a.decision==='block'&&!a.effectOccurred))
   assert.match(answers[2].reason,/velocity/)
  }
  await f.write('stops',{numberId:f.numberId,recipient:'+15125550126',channel:'sms',reason:'consent_revoked',confirm:'record outbound consent stop'})
  assert.equal((await f.check({channel:'sms',direction:'outbound',address:'+15125550126',deviceId:'synthetic-handset-644',eventKey:'synthetic-handset-645'})).reason,'consent_revoked')
  await f.write('configure',{...f.route,revision:1,continuationUrl:'',emergencyUrl:''},200)
  const unqualified=await f.carrier({CallSid:'synthetic-handset-646'})
  assert.equal(unqualified.status,503);assert.equal((await unqualified.json()).error,'inbound_continuation_unconfigured')
  const emergency=await f.carrier({From:'client:synthetic-handset-647',To:'911',CallSid:'synthetic-handset-648'})
  assert.equal(emergency.status,503);const held=await emergency.json();assert.equal(held.error,'emergency_route_unqualified');assert.equal(held.decision.decision,'exempt')
  await post(runtime,'/api/handset/sources/revoke',{sourceId:f.source.id},f.headers)
  assert.equal((await f.carrier({CallSid:'synthetic-handset-649'})).status,403)
 }finally{await runtime.close()}
})

// All qualification receipts below are synthetic network-edge evidence. These
// journeys never constitute final legal review or permitted real-traffic proof.
import { dialerFixture } from './helpers/handset-dialer.mjs'

test('Each outbound mode preserves staffed inbound capacity, caller checks, progress and connected calls during pauses and approval revocation',async()=>{
 const runtime=await openHandset({twilio:true})
 try{
  const f=await dialerFixture(runtime)
  for(const mode of ['preview','progressive','power','parallel','predictive']){
   const l=await f.makeList({count:mode==='predictive'?5:4})
   let ordinal=0
   if(mode==='predictive'){
    const bootstrap=await f.session(l,'progressive');await f.ready()
    const call=f.prepare(l,ordinal),result=await f.launch(bootstrap,l.recipients[ordinal].recipient),a=result.attempts[0]
    assert.ok(a,JSON.stringify(result));await f.connect(a,call);await f.finish(a,call);ordinal++
   }
   const run=await f.session(l,mode)
   await f.ready()
   const call=f.prepare(l,ordinal),launched=await f.launch(run,l.recipients[ordinal].recipient),a=launched.attempts[0]
   assert.ok(a,JSON.stringify(launched));assert.ok(a.provider_sid)
   await f.connect(a,call)
   let current=await f.read()
   assert.equal(current.reservations.filter(r=>r.attempt_id===a.id).length,1)
   const cursor=current.sessions.find(s=>s.id===run.id).cursor
   await f.q.presence(f.q.english,'offline')
   const stopped=await f.launch(run,l.recipients[cursor].recipient)
   assert.match(stopped.held,/inbound_staff_reserve|waiting_agent_required/)
   current=await f.read();assert.equal(current.sessions.find(s=>s.id===run.id).cursor,cursor)
   assert.equal(current.attempts.find(x=>x.id===a.id).state,'active','unstaffing preserves connected calls')
   await f.finish(a,call)
   await f.ready();await f.write(f.base+'/sessions/'+run.id+'/resume',{})
   await f.write('/api/handset/protection/stops',{numberId:f.numberId,recipient:l.recipients[cursor].recipient,channel:'all',reason:'dnc',confirm:'record outbound consent stop'},201)
   const before=runtime.sourceRequests.filter(r=>r.method==='POST').length,skipped=await f.launch(run,l.recipients[cursor].recipient)
   assert.equal(skipped.attempts[0].reason,'dnc');assert.equal(runtime.sourceRequests.filter(r=>r.method==='POST').length,before)
   const incoming=await f.q.admit(f.q.sales)
   await runtime.sql('UPDATE hnd_queue_entries SET queued_at=? WHERE id=?',Date.now()-30000,incoming.id)
   const breached=await f.launch(run,l.recipients[cursor+1].recipient)
   assert.equal(breached.held,'inbound_service_breach');assert.equal(breached.session.cursor,cursor+1)
   await f.q.action(incoming.id,'abandon');await f.write(f.base+'/sessions/'+run.id+'/resume',{});await f.ready()
   const nextCall=f.prepare(l,cursor+1),nextResult=await f.launch(run,l.recipients[cursor+1].recipient),active=nextResult.attempts[0]
   assert.ok(active,JSON.stringify(nextResult));await f.connect(active,nextCall)
   await f.write(f.base+'/lists/'+l.id+'/revoke',{})
   const denied=await post(runtime,f.base+'/sessions/'+run.id+'/launch',{eventKey:f.next(),previewRecipient:l.recipients[cursor+2].recipient,confirm:'launch exact approved recipients now'},f.headers)
   assert.equal(denied.status,409)
   current=await f.read();assert.equal(current.attempts.find(x=>x.id===active.id).state,'active')
   assert.equal(current.sessions.find(x=>x.id===run.id).cursor,cursor+2)
   await f.finish(active,nextCall)
   const deal=await runtime.request('/api/handset/cases/'+l.recipients[cursor+1].caseId,{headers:f.headers}),records=(await deal.json()).records
   assert.ok(records.some(r=>r.kind==='disposition'&&JSON.parse(r.data).mode===mode))
  }
 }finally{await runtime.close()}
})

test('Bounded parallel calls reserve distinct waiting agents; an uncertain carrier creation is never retried or released by restart',async()=>{
 const runtime=await openHandset({twilio:true})
 try{
  const f=await dialerFixture(runtime),second=await f.addAgent(),l=await f.makeList({count:4,mode:'parallel'}),run=await f.session(l,'parallel')
  await f.ready();const call1=f.prepare(l,0)
  await f.ready(second);const call2=f.prepare(l,1)
  const creates=`https://api.twilio.com/2010-04-01/Accounts/${f.account}/Calls.json`
  runtime.twilioResources.set(creates,{__responses:[call1.creation,call2.creation]})
  const eventKey=f.next(),result=await f.launch(run,l.recipients[0].recipient,{eventKey})
  assert.equal(result.attempts.length,2,JSON.stringify(result))
  let current=await f.read();assert.equal(current.reservations.length,2)
  assert.equal(new Set(current.reservations.map(r=>r.agent_id)).size,2)
  const before=runtime.sourceRequests.filter(r=>r.method==='POST').length
  const repeated=await f.launch(run,l.recipients[0].recipient,{eventKey})
  assert.equal(repeated.replay,true);assert.equal(runtime.sourceRequests.filter(r=>r.method==='POST').length,before)
  await runtime.restart()
  const replay=await f.launch(run,l.recipients[0].recipient,{eventKey})
  assert.equal(replay.replay,true);current=await f.read();assert.equal(current.reservations.length,2)
  const over=await f.launch(run,l.recipients[2].recipient)
  assert.equal(over.held,'inbound_staff_reserve')
  for(const [a,call] of [[result.attempts[0],call1],[result.attempts[1],call2]]){await f.connect(a,call);await f.finish(a,call)}
  const uncertain=await f.makeList({count:2,mode:'power'}),uncertainRun=await f.session(uncertain,'power')
  await f.ready();const lost=f.prepare(uncertain,0,{createStatus:503}),lostKey=f.next(),pending=await f.launch(uncertainRun,uncertain.recipients[0].recipient,{eventKey:lostKey}),a=pending.attempts[0]
  assert.equal(a.state,'uncertain');assert.equal(a.provider_sid,null)
  const paid=runtime.sourceRequests.filter(r=>r.method==='POST').length
  await runtime.restart();await runtime.scheduled()
  await f.launch(uncertainRun,uncertain.recipients[0].recipient,{eventKey:lostKey})
  assert.equal(runtime.sourceRequests.filter(r=>r.method==='POST').length,paid)
  current=await f.read();assert.ok(current.reservations.some(r=>r.attempt_id===a.id));assert.equal(current.sessions.find(x=>x.id===uncertainRun.id).cursor,1)
  const receipt=await f.callback(a,lost);assert.equal(receipt.status,200,await receipt.clone().text())
  current=await f.read();assert.equal(current.attempts.find(x=>x.id===a.id).provider_sid,lost.sid)
  assert.equal((await f.callback(a,lost,'answer',{signature:false})).status,403)
  const audit=await (await runtime.request('/api/handset/audit/export',{headers:f.headers})).json()
  const observed=audit.rows.filter(r=>r.subject===a.id&&r.actor===f.source.id).map(r=>JSON.parse(r.policy).applied)
  assert.ok(observed.some(p=>p.source?.id===f.source.id&&p.source.revision===f.source.revision&&p.list?.id===uncertain.id&&p.qualification?.id===f.qualified.id),'reconciled provider attempts retain the exact original source, reviewed list and qualification')
 }finally{await runtime.close()}
})

test('Dialer exact evidence, native consent and standing policy cannot be broadened through direct APIs or stale approvals',async()=>{
 const runtime=await openHandset({twilio:true})
 try{
  const f=await dialerFixture(runtime)
  assert.equal((await runtime.request(f.base)).status,401)
  const unqualified=await post(runtime,f.base+'/qualifications',{...f.qualificationInput,legalEvidenceId:'synthetic-handset-2999'},f.headers)
  assert.equal(unqualified.status,409)
  const policy=await f.write(f.base+'/policies',{repIds:[f.q.english],purpose:f.purpose,sourceIds:[f.source.id],modes:['progressive','power'],maxListSize:4,maxBudgetCents:1000,attemptCents:100,startsAt:Date.now()-1000,expiresAt:Date.now()+2000000,confirm:'approve exact standing CRM list policy'},201)
  const first=await f.makeList({policyId:policy.id,mode:'progressive'}),second=await f.makeList({policyId:policy.id,mode:'power'})
  assert.equal(first.approved_by,second.approved_by);assert.equal(first.policy_revision,second.policy_revision)
  assert.notEqual(first.snapshot_hash,second.snapshot_hash)
  const outside=await post(runtime,f.base+'/lists',{...first.input,name:f.next(),purpose:'Synthetic different purpose'},f.headers)
  assert.equal(outside.status,409)
  const budget=await post(runtime,f.base+'/lists',{...first.input,name:f.next(),budgetCents:2000},f.headers)
  assert.equal(budget.status,409)
  await f.ready();const run=await f.session(second,'power')
  await f.write(f.base+'/policies/'+policy.id+'/revoke',{})
  const revoked=await post(runtime,f.base+'/sessions/'+run.id+'/launch',{eventKey:f.next(),confirm:'launch exact approved recipients now'},f.headers)
  assert.equal(revoked.status,409);assert.ok(runtime.sourceRequests.every(r=>r.method==='GET'))
  const unverified=await f.makeList({count:1,mode:'preview',check:false}),needsReview=await f.session(unverified,'preview')
  await f.ready()
  const noConsent=await f.launch(needsReview,unverified.recipients[0].recipient)
  assert.equal(noConsent.held,'current_recipient_verification_required','a pending native record alone grants no calling consent')
  assert.equal(noConsent.attempts.length,0)
  assert.ok(runtime.sourceRequests.every(r=>r.method==='GET'))
  const unknown=await f.makeList({count:2,mode:'predictive',check:false}),predictive=await f.session(unknown,'predictive')
  const held=await f.launch(predictive,unknown.recipients[0].recipient)
  assert.equal(held.held,'predictive_observations_insufficient')
  const l=await f.makeList({count:2,mode:'preview'}),preview=await f.session(l,'preview')
  assert.equal((await post(runtime,f.base+'/sessions/'+preview.id+'/launch',{eventKey:f.next(),previewRecipient:'+15125559999',confirm:'launch exact approved recipients now'},f.headers)).status,409)
  await f.verify(l,0,l.recipients[0].consentId,{national:'unknown'})
  const stopped=await f.launch(preview,l.recipients[0].recipient)
  assert.equal(stopped.attempts[0].reason,'national_dnc_unknown')
  assert.ok(runtime.sourceRequests.every(r=>r.method==='GET'),'unknown checks and standing revocation emit no carrier instruction')
  const unsafe=await f.makeList({count:2,mode:'progressive'}),safetyRun=await f.session(unsafe,'progressive')
  await f.ready();const safetyCall=f.prepare(unsafe,0),launched=await f.launch(safetyRun,unsafe.recipients[0].recipient),safetyAttempt=launched.attempts[0]
  assert.ok(safetyAttempt,JSON.stringify(launched))
  await f.q.presence(f.q.english,'offline')
  f.updateCall(safetyCall,{status:'in-progress',start_time:new Date().toUTCString()})
  const safety=await f.callback(safetyAttempt,safetyCall,'answer')
  assert.equal(safety.status,200,await safety.clone().text());const instructions=await safety.text()
  assert.match(instructions,/<Say>/);assert.match(instructions,/<Hangup\/>/);assert.doesNotMatch(instructions,/<Conference|<Pause/)
  const report=await runtime.request(f.base+'/lists/'+unsafe.id+'/report',{headers:f.headers}),observed=await report.json()
  assert.equal(observed.abandoned,1);assert.equal(observed.humanAnswerDenominator,1)
  await runtime.sql('UPDATE oa_operators SET status=?,role=? WHERE id=?','active','admin','synthetic-handset-2')
  const borrowed=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  assert.equal((await runtime.request(f.base,{headers:{cookie:borrowed.cookie}})).status,403)
  const html=await runtime.request('/app/dialer',{headers:f.headers});assert.equal(html.status,200)
  const audit=(await (await runtime.request('/api/handset/audit/export',{headers:f.headers})).json()).rows
  assert.ok(audit.some(r=>r.action==='product.request'&&r.subject===policy.id))
 }finally{await runtime.close()}
})

test('Signed keypad screening is bounded, call-scoped and one-shot while current policy and source authority govern continuation',async()=>{
 const runtime=await openHandset({twilio:true})
 try{await screeningJourney(runtime)}finally{await runtime.close()}
})

test('Imported compliance results, state rules and scoped review-dated approvals govern exact lists and paid launches',async()=>{
 const runtime=await openHandset({twilio:true})
 try{
  const f=await dialerFixture(runtime),l=await f.makeList({count:1,mode:'progressive'}),recipient=l.recipients[0],run=await f.session(l,'progressive')
  await f.ready()
  const writes=()=>runtime.sourceRequests.filter(r=>r.method==='POST').length,before=writes()
  await f.importResults('national',{rows:[{recipient:recipient.recipient,status:'blocked'}]})
  assert.equal((await post(runtime,f.base+'/lists',{...l.input,name:f.next()},f.headers)).status,409,'registry suppression refuses approval despite a human clear attestation')
  await f.verify(l,0,recipient.consentId)
  let outcome=await f.launch(run,recipient.recipient)
  assert.equal(outcome.held,'national_blocked');assert.equal(writes(),before)
  await f.importResults('national',{publishedAt:Date.now()-32*86400000})
  await f.write(f.base+'/sessions/'+run.id+'/resume',{})
  outcome=await f.launch(run,recipient.recipient)
  assert.equal(outcome.held,'national_extract_missing_or_stale');assert.equal(writes(),before)
  await f.importResults('national')
  await f.importResults('reassigned',{rows:[{recipient:recipient.recipient,consentId:recipient.consentId,status:'reassigned'}]})
  await f.write(f.base+'/sessions/'+run.id+'/resume',{})
  outcome=await f.launch(run,recipient.recipient)
  assert.equal(outcome.held,'reassigned_reassigned');assert.equal(writes(),before)
  await f.importResults('reassigned')
  // Explicit source/queue/budget grants distinguish named list approval from
  // management's authority to approve a standing policy.
  const manager=f.q.spanish
  await f.write(f.base+'/approver-scopes',{operatorId:manager,sourceIds:[f.source.id],queueIds:[f.q.sales.id],budgetCents:1000,standing:1,reviewAt:Date.now()+7*86400000,confirm:'grant exact campaign approval scope'},201)
  const managerCookie=(await signIn({...runtime,ownerEmail:manager+'@example.test'})).cookie
  assert.equal((await post(runtime,f.base+'/lists',{...l.input,name:f.next(),budgetCents:1001},{cookie:managerCookie})).status,403)
  assert.equal((await post(runtime,f.base+'/lists',{...l.input,name:f.next(),queueId:f.q.support.id},{cookie:managerCookie})).status,403)
  const scoped=await post(runtime,f.base+'/lists',{...l.input,name:f.next(),expiresAt:Date.now()+5*86400000},{cookie:managerCookie})
  assert.equal(scoped.status,201,await scoped.clone().text());assert.equal((await scoped.json()).approved_by,manager)
  const policyResponse=await post(runtime,f.base+'/policies',{repIds:[f.q.english],purpose:f.purpose,sourceIds:[f.source.id],queueIds:[f.q.sales.id],modes:['progressive'],maxListSize:10,maxBudgetCents:1000,attemptCents:100,startsAt:Date.now()-2*86400000,expiresAt:Date.now()+5*86400000,confirm:'approve exact standing CRM list policy'},{cookie:managerCookie})
  assert.equal(policyResponse.status,201,await policyResponse.clone().text());const policy=await policyResponse.json()
  await runtime.sql('UPDATE hnd_dialer_policies SET created_at=created_at-? WHERE id=?',2*86400000,policy.id)
  const governed=await f.makeList({count:1,mode:'progressive',policyId:policy.id,expiresAt:Date.now()+4*86400000})
  assert.equal(governed.approved_by,manager)
  assert.equal(writes(),before,'imports and approvals launch nothing')
  const waiting=await f.ready(manager,{persist:false})
  const ready=await post(runtime,f.base+'/ready',{agentId:manager,sourceId:f.source.id,conferenceSid:waiting.conferenceSid,conferenceName:waiting.conferenceName,agentCallSid:waiting.agentCallSid,expiresAt:Date.now()+80000,confirm:'reserve this independently connected waiting agent'},{cookie:managerCookie})
  assert.equal(ready.status,200,await ready.clone().text())
  assert.equal((await post(runtime,f.base+'/ready',{agentId:f.q.english,sourceId:f.source.id,confirm:'reserve this independently connected waiting agent'},{cookie:managerCookie})).status,403)
  // Pick the independently readied member rather than the earlier owner ready.
  await runtime.sql('UPDATE hnd_dialer_ready SET expires_at=? WHERE agent_id=?',Date.now()-1,f.q.english)
  const governedRun=await f.session(governed,'progressive'),call=f.prepare(governed),launched=await f.launch(governedRun,governed.recipients[0].recipient)
  assert.ok(launched.attempts[0]?.provider_sid,JSON.stringify(launched));assert.equal(launched.attempts[0].agent_id,manager)
  await f.connect(launched.attempts[0],call);await f.finish(launched.attempts[0],call)
  await runtime.sql('UPDATE hnd_dialer_policies SET expires_at=? WHERE id=?',Date.now()-1,policy.id)
  const expired=await post(runtime,f.base+'/lists/'+governed.id+'/sessions',{mode:'progressive',confirm:'start exact approved list in this mode'},f.headers)
  assert.equal(expired.status,409)
  await f.write(f.base+'/approver-scopes/revoke',{operatorId:manager})
  assert.equal((await post(runtime,f.base+'/lists',{...l.input,name:f.next()},{cookie:managerCookie})).status,403)
  await f.write(f.base+'/state-rules',{jurisdiction:'US-FL',startMinute:480,endMinute:1200,maxAttempts:3,windowHours:24,writtenModes:['progressive'],evidenceId:f.evidence,reviewAt:Date.now()+30*86400000,confirm:'approve reviewed state calling rules'},201)
  assert.equal((await post(runtime,f.base+'/lists',{...l.input,name:f.next(),expiresAt:Date.now()+91*86400000},f.headers)).status,400,'review date cannot exceed 90 days')
  const florida={...recipient,jurisdiction:'US-FL',timezone:'Pacific/Honolulu',writtenConsentEvidenceId:f.evidence}
  const preview=await f.write(f.base+'/state-preview',{recipient:florida.recipient,timezone:'America/New_York',jurisdiction:'US-FL',consentId:florida.consentId,writtenConsentEvidenceId:f.evidence,mode:'progressive',at:Date.parse('2026-10-22T00:30:00Z')})
  assert.equal(preview.reason,'recipient_quiet_hours','20:30 Florida local is refused by the same state gate');assert.equal(preview.authorityGranted,false)
  const fl=await f.makeList({count:1,mode:'progressive',recipients:[florida]})
  const {writtenConsentEvidenceId,...missingWritten}=florida
  assert.equal((await post(runtime,f.base+'/lists',{...fl.input,name:f.next(),recipients:[missingWritten]},f.headers)).status,409,'a mode requiring written consent cannot use a bare consent attestation')
  // Three actual network-edge call creations to this recipient are retained
  // across separate approved lists; a fourth cannot bypass frequency limits.
  for(let n=0;n<3;n++){
   const current=n?{...await f.write(f.base+'/lists',{...fl.input,name:f.next()},201),input:fl.input,recipients:fl.recipients}:fl
   if(n)await f.verify(current,0,florida.consentId)
   await f.ready();const session=await f.session(current,'progressive'),c=f.prepare(current),result=await f.launch(session,florida.recipient)
   assert.ok(result.attempts[0]?.provider_sid,JSON.stringify(result));await f.connect(result.attempts[0],c);await f.finish(result.attempts[0],c)
  }
  const fourth={...await f.write(f.base+'/lists',{...fl.input,name:f.next()},201),input:fl.input,recipients:fl.recipients}
  await f.verify(fourth,0,florida.consentId);await f.ready();const fourthRun=await f.session(fourth,'progressive'),count=writes(),refused=await f.launch(fourthRun,florida.recipient)
  assert.equal(refused.held,'state_frequency_limit');assert.equal(writes(),count)
 }finally{await runtime.close()}
})
