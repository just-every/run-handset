import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'
import { sourceFixture } from './helpers/handset-sources.mjs'
import { queueFixture, queueProviderFixture } from './helpers/handset-queues.mjs'

// Small batches exercise independent ingress without turning ledger contention
// into a CPU load test on the shared development machine.
async function surge(count,action){
 const result=[]
 for(let start=0;start<count;start+=4)result.push(...await Promise.all(Array.from({length:Math.min(4,count-start)},(_,offset)=>action(start+offset))))
 return result
}
const counts=(data,state)=>data.entries.filter(e=>e.state===state).length

test('Twenty native inbound calls retain fair language and priority reservations across restart, abandonment, wrap-up and maximum wait',async()=>{
 const runtime=await openHandset()
 try{
  const f=await queueFixture(runtime)
  const calls=await surge(20,i=>f.admit(f.sales,i%2?'en':'es',i===0?100:i===1?50:0))
  // Control chronology through persisted timestamps, never sleep or replace
  // a routing outcome. The public dispatcher must still choose the winner.
  const now=Date.now()
  for(const [i,c] of calls.entries())await runtime.sql('UPDATE hnd_queue_entries SET queued_at=? WHERE id=?',now-20000+i,c.id)
  let state=await f.read()
  assert.equal(counts(state,'waiting'),20)
  assert.equal(state.announcements.length,20)
  assert.equal(new Set(state.announcements.map(a=>a.position)).size,20)
  assert.ok(state.announcements.every(a=>a.delivery_state==='pending'&&a.estimated_wait_seconds===null),'prepared instructions never claim audio delivery or invent an estimate')
  await f.write(f.base+'/'+f.sales.id+'/dispatch',{})
  state=await f.read()
  assert.equal(counts(state,'reserved'),2);assert.equal(counts(state,'waiting'),18)
  assert.equal(state.entries.find(e=>e.id===calls[0].id).agent_id,f.spanish)
  assert.equal(state.entries.find(e=>e.id===calls[1].id).agent_id,f.english)
  const before=state.reservations.map(r=>[r.entry_id,r.agent_id,r.slot]).sort()
  assert.equal(typeof runtime.restart,'function','the public-door harness must restart the emitted Worker while retaining native D1')
  await runtime.restart()
  state=await f.read()
  assert.deepEqual(state.reservations.map(r=>[r.entry_id,r.agent_id,r.slot]).sort(),before)
  await runtime.sql("UPDATE hnd_queue_reservations SET lease_until=? WHERE state='reserved'",Date.now()-1)
  await f.write(f.base+'/reconcile',{})
  state=await f.read();assert.equal(state.reservations.length,0);assert.equal(counts(state,'waiting'),20)
  await f.write(f.base+'/'+f.sales.id+'/dispatch',{})
  await f.action(calls[0].id,'accept');await f.action(calls[0].id,'complete')
  await f.write(f.base+'/'+f.sales.id+'/dispatch',{})
  state=await f.read()
  assert.equal(state.agents.find(a=>a.operator_id===f.spanish).wrapping,true)
  assert.equal(state.entries.find(e=>e.id===calls[2].id).state,'waiting')
  await f.action(calls[1].id,'abandon')
  assert.equal((await f.read()).reservations.length,0)
  // Calls stay in their original fair order after a lease releases.
  await runtime.sql('UPDATE hnd_queue_agents SET wrap_until=?,heartbeat_at=? WHERE operator_id=?',Date.now()-1,Date.now(),f.spanish)
  await f.presence(f.english)
  const races=await Promise.all([post(runtime,f.base+'/'+f.sales.id+'/dispatch',{},f.headers),post(runtime,f.base+'/'+f.sales.id+'/dispatch',{},f.headers)])
  assert.ok(races.every(r=>[200,409].includes(r.status)))
  state=await f.read()
  assert.equal(new Set(state.reservations.map(r=>r.agent_id+':'+r.slot)).size,state.reservations.length)
  assert.equal(state.entries.find(e=>e.id===calls[2].id).state,'reserved')
  await runtime.sql("UPDATE hnd_queue_entries SET deadline_at=? WHERE state IN ('waiting','reserved')",Date.now()-1)
  await f.write(f.base+'/reconcile',{})
  state=await f.read()
  assert.equal(counts(state,'waiting'),0);assert.equal(counts(state,'reserved'),0);assert.equal(state.reservations.length,0)
  assert.equal(counts(state,'overflow'),18)
  assert.ok(state.entries.filter(e=>e.state==='overflow').every(e=>e.reason==='maximum_wait'&&e.overflow_kind==='voicemail'))
  const stream=await (await runtime.request(f.base+'/events',{headers:f.headers})).json()
  assert.ok(stream.events.some(e=>e.type==='reservation.released'))
  assert.ok(stream.events.every(e=>e.payload.transport==='unknown'))
  await assert.rejects(runtime.sql("UPDATE hnd_queue_events SET type='synthetic-handset-999' WHERE sequence=1"),/append_only/)
 }finally{await runtime.close()}
})

test('Queue logout is independent of global availability, protects active work and wrap-up, and refuses stale or unqualified staffing',async()=>{
 const runtime=await openHandset()
 try{
  const f=await queueFixture(runtime)
  await f.changeMembership(f.sales,f.english,0)
  const [sales,support]=await Promise.all([f.admit(f.sales),f.admit(f.support)])
  await f.write(f.base+'/'+f.sales.id+'/dispatch',{})
  await f.write(f.base+'/'+f.support.id+'/dispatch',{})
  let state=await f.read()
  assert.equal(state.entries.find(e=>e.id===sales.id).state,'overflow')
  assert.equal(state.entries.find(e=>e.id===support.id).agent_id,f.english)
  await f.action(support.id,'accept')
  await f.changeMembership(f.support,f.english,0)
  await f.presence(f.english,'offline')
  state=await f.read()
  assert.equal(state.entries.find(e=>e.id===support.id).state,'active')
  assert.equal(state.reservations.find(r=>r.entry_id===support.id).state,'active')
  const next=await f.admit(f.support)
  await f.write(f.base+'/'+f.support.id+'/dispatch',{})
  assert.equal((await f.read()).entries.find(e=>e.id===next.id).state,'overflow')
  await f.action(support.id,'complete')
  await f.changeMembership(f.sales,f.english,1);await f.presence(f.english)
  const wrapped=await f.admit(f.sales)
  await f.write(f.base+'/'+f.sales.id+'/dispatch',{})
  assert.equal((await f.read()).entries.find(e=>e.id===wrapped.id).state,'waiting')
  await runtime.sql('UPDATE hnd_queue_agents SET wrap_until=?,heartbeat_at=? WHERE operator_id=?',Date.now()-1,Date.now()-100000,f.english)
  await f.write(f.base+'/'+f.sales.id+'/dispatch',{})
  state=await f.read()
  assert.equal(state.agents.find(a=>a.operator_id===f.english).presenceFresh,false)
  assert.equal(state.entries.find(e=>e.id===wrapped.id).reason,'no_eligible_agent')
  await f.presence(f.english)
  const overflow=await f.createQueue('Spanish overflow / Desborde',{overflowKind:'queue',overflowQueueId:f.support.id})
  const target=await f.admit(overflow,'es')
  await f.write(f.base+'/'+overflow.id+'/dispatch',{})
  state=await f.read()
  assert.equal(state.entries.find(e=>e.id===target.id).queue_id,f.support.id)
  assert.equal(state.entries.find(e=>e.id===target.id).state,'waiting')
  const cycle=await post(runtime,f.base+'/'+f.support.id+'/configure',{name:f.support.name,skills:[],maxWaitSeconds:30,wrapSeconds:10,maxWaiting:100,overflowKind:'queue',overflowQueueId:overflow.id,revision:f.support.revision,confirm:'approve native queue policy'},f.headers)
  assert.equal(cycle.status,400)
  assert.equal((await runtime.request(f.base)).status,401)
  assert.equal((await post(runtime,f.base+'/presence',{operatorId:f.english,availability:'available',revision:1},{...f.headers,origin:'https://synthetic-handset-999.example.test'})).status,403)
  await runtime.sql("UPDATE oa_operators SET status='active' WHERE id='synthetic-handset-2'")
  const member=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  assert.equal((await runtime.request(f.base,{headers:{cookie:member.cookie}})).status,403)
 }finally{await runtime.close()}
})

test('Signed official-schema Voice requests admit a twenty-call surge and emit position TwiML while refusing fabricated delivery, foreign scopes and revoked sources',async()=>{
 const runtime=await openHandset({twilio:true})
 try{
  const source=await sourceFixture(runtime),f=await queueFixture(runtime,source.cookie)
  const binding=await f.write(f.base+'/sources',{sourceId:source.source.id,queueId:f.sales.id,language:'en',spanishDigit:'2',confirm:'authorize signed inbound queue routing'},201)
  const edge=queueProviderFixture(runtime,source,binding),calls=Array.from({length:20},(_,i)=>({...edge.resource(i),...(i%2?{}:{Digits:'2'})}))
  // Twilio invokes this public URL for each inbound leg. Serialize callbacks
  // here because each arrival dispatches the shared queue as a single policy.
  for(const call of calls){
   const response=await edge.callback(call)
   assert.equal(response.status,200,await response.clone().text())
   const twiml=await response.text()
   assert.match(twiml,/<Response><Say language="(?:es-MX|en-US)">/)
   assert.match(twiml,/<Redirect method="POST">/)
   assert.ok(!twiml.includes('<Dial')&&!twiml.includes('delivered'))
  }
  let state=await f.read()
  assert.equal(state.entries.length,20);assert.equal(state.reservations.length,2)
  assert.equal(state.announcements.length,20)
  assert.ok(state.entries.some(e=>e.language==='es'&&e.agent_id===f.spanish))
  assert.ok(state.announcements.every(a=>a.delivery_state==='pending'))
  assert.equal(runtime.sourceRequests.filter(r=>r.url.includes('/Calls/')).length,20)
  assert.ok(runtime.sourceRequests.every(r=>r.method==='GET'),'no provider call creation or paid dialing is fabricated')
  const reserved=state.entries.find(e=>e.state==='reserved')
  assert.equal((await post(runtime,f.base+'/entries/'+reserved.id+'/accept',{revision:reserved.revision},f.headers)).status,409)
  const before=state.entries.length
  assert.equal((await edge.callback(edge.resource(30),{signature:false})).status,403)
  assert.equal((await edge.callback(edge.resource(31),{signedOrigin:'https://synthetic-handset-999.example.test'})).status,403)
  assert.equal((await edge.callback({...edge.resource(32),AccountSid:'synthetic-handset-999'})).status,403)
  assert.equal((await edge.callback({...edge.resource(33),To:'+15125550199'})).status,403)
  assert.equal((await f.read()).entries.length,before)
  // Provider-reported abandon clears its real native reservation; a terminal
  // callback never manufactures an answered leg or a successful bridge.
  assert.equal((await edge.callback({...calls[0],CallStatus:'completed'})).status,200)
  state=await f.read();assert.equal(state.reservations.length,1);assert.equal(counts(state,'abandoned'),1)
  await runtime.sql("UPDATE hnd_queue_entries SET deadline_at=? WHERE state IN ('waiting','reserved')",Date.now()-1)
  const overflow=await edge.callback(calls[1]);assert.equal(overflow.status,200)
  const xml=await overflow.text();assert.match(xml,/<Hangup\/>/);assert.match(xml,/not available/)
  state=await f.read();assert.equal(counts(state,'overflow'),19);assert.equal(state.reservations.length,0)
  await f.write(f.base+'/sources/revoke',{bindingId:binding.id})
  assert.equal((await edge.callback(calls[2])).status,403)
  const result=await runtime.request('/api/handset/audit/export',{headers:f.headers}),audit=await result.json()
  assert.ok(audit.rows.some(r=>r.action==='source.refuse'&&r.outcome==='refused'))
 }finally{await runtime.close()}
})
