import assert from 'node:assert/strict'
import { post } from './handset-auth.mjs'
import { protectionFixture,readProtectionChallenge } from './handset-protection.mjs'

export async function screeningJourney(runtime){
 const f=await protectionFixture(runtime)
 const rule=await f.rule({effect:'screen',channel:'voice'})
 const start=id=>f.startScreening({CallSid:'synthetic-handset-'+id})
 const completed=await start(1700)
 assert.match(completed.twiml,/language="en-US"/);assert.match(completed.twiml,/language="es-US"/)
 assert.equal((await completed.answer(completed,completed.digit,{CallSid:'synthetic-handset-1701'})).status,403)
 assert.equal((await completed.answer(completed,completed.digit,{From:'+15125550199'})).status,403)
 assert.equal((await completed.answer(completed,completed.digit,{}, {signature:false})).status,403)
 const received=await completed.answer();assert.equal(received.status,200);assert.ok((await received.text()).includes(f.continuation))
 assert.equal((await completed.answer()).status,409)
 assert.equal((await f.carrier({CallSid:'synthetic-handset-1700'})).status,409,'initial replay cannot restart a passed challenge')
 const bounded=await start(1702)
 let round=bounded,submissions=0,terminal
 while(submissions<10){
  const response=await bounded.answer(round,submissions%2?'0':null);submissions++
  assert.equal(response.status,200,await response.clone().text())
  const body=await response.clone().text()
  if(!body.includes('<Gather')){terminal=body;break}
  const next=await readProtectionChallenge(response)
  assert.equal((await bounded.answer(round,round.digit)).status,409,'consumed rounds cannot pass or reset the attempt count')
  round=next
 }
 assert.ok(terminal?.includes('<Hangup/>'));assert.ok(!terminal.includes('<Redirect'))
 const state=await f.overview(),failed=state.challenges.find(c=>c.call_sid==='synthetic-handset-1702')
 assert.equal(state.challenges.find(c=>c.call_sid==='synthetic-handset-1700').status,'passed')
 assert.equal(failed.status,'failed');assert.equal(failed.attempts,submissions)
 assert.ok(state.challenges.every(c=>!Object.hasOwn(c,'digit')),'owner status excludes the expected response')
 const race=await start(1703),outcomes=await Promise.all([race.answer(),race.answer()])
 const bodies=await Promise.all(outcomes.map(r=>r.text()))
 assert.equal(bodies.filter(body=>body.includes('<Redirect')).length,1,'only one concurrent action issues continuation')
 const changed=await start(1704)
 const latest='https://synthetic-handset-600.example.test/reviewed-continuation'
 await f.write('configure',{...f.route,revision:1,continuationUrl:latest},200)
 assert.ok((await (await changed.answer()).text()).includes(latest),'continuation uses the current approved route')
 const revoked=await start(1705)
 await f.write('revoke',{ruleId:rule.id},200)
 const refused=await revoked.answer();assert.equal(refused.status,200);assert.ok(!(await refused.text()).includes('<Redirect'))
 await f.rule({effect:'screen',channel:'voice'})
 const callback=await start(1706)
 await f.write('callbacks',{numberId:f.numberId,caller:'+15125550127',expiresAt:Date.now()+3600000,confirm:'designate emergency callback'})
 assert.ok((await (await callback.answer(callback,'0')).text()).includes(latest),'current designated callback bypasses screening')
 await f.rule({matchKind:'number',pattern:'+15125550126',effect:'allow'})
 assert.ok((await (await f.carrier({CallSid:'synthetic-handset-1707',From:'+15125550126'})).text()).includes(latest))
 const other=await f.startScreening({CallSid:'synthetic-handset-1708',From:'+15125550129'})
 await post(runtime,'/api/handset/sources/revoke',{sourceId:f.source.id},f.headers)
 assert.equal((await other.answer()).status,403,'revoked source cannot continue an existing challenge')
 assert.equal(runtime.sourceRequests.filter(r=>r.method!=='GET').length,0,'screening never creates a paid call or recording')
}
