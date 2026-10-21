import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'
import { protectionFixture } from './helpers/handset-protection.mjs'

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
  const history=await runtime.request('/api/handset/audit/export',{headers:f.headers}),rows=(await history.json()).rows
  assert.ok(rows.some(r=>r.action==='protection.rule'&&r.subject===block.id))
  assert.ok(rows.some(r=>r.action==='protection.revoke'&&r.subject===block.id))
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
