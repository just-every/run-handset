import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'
import { sourceFixture } from './helpers/handset-sources.mjs'
import { queueFixture, authorizeQueueMedia, capacityFixture } from './helpers/handset-queues.mjs'

// Small batches exercise independent ingress without turning ledger contention
// into a CPU load test on the shared development machine.
async function surge(count,action){
 const result=[]
 for(let start=0;start<count;start+=4)result.push(...await Promise.all(Array.from({length:Math.min(4,count-start)},(_,offset)=>action(start+offset))))
 return result
}
const counts=(data,state)=>data.entries.filter(e=>e.state===state).length

test('A 200-person roster and 100 configured agents admit a concurrent twenty-call signed surge, refuse saturation and retain unique reservations after restart',async t=>{
 const runtime=await openHandset({twilio:true})
 try{
  const started=performance.now(),source=await sourceFixture(runtime),f=await capacityFixture(runtime,source)
  const roster=await f.read('/auth/operators')
  assert.equal(roster.length,200)
  assert.ok(roster.every(p=>p.status==='active'))
  let state=await f.read()
  assert.equal(state.agents.length,100)
  assert.ok(state.agents.every(a=>a.operator_status==='active'&&a.availability==='available'&&a.presenceFresh&&a.capacity===1))
  assert.equal(state.memberships.filter(m=>m.queue_id===f.queue.id&&m.logged_in).length,100)
  assert.equal(state.capacity[0].admissionLimit,20);assert.equal(state.capacity[0].remaining,20)
  const configuredMs=performance.now()-started,calls=Array.from({length:20},(_,i)=>f.edge.resource(200+i)),surgeStart=performance.now()
  const responses=await Promise.all(calls.map(call=>f.edge.callback(call)))
  const instructions=await Promise.all(responses.map(async r=>({status:r.status,body:await r.text()})))
  assert.ok(instructions.every(r=>r.status===200),JSON.stringify(instructions))
  state=await f.read()
  assert.equal(state.entries.length,20);assert.equal(state.reservations.length,20)
  assert.equal(new Set(state.reservations.map(r=>r.agent_id+':'+r.slot)).size,20)
  assert.equal(new Set(state.entries.map(e=>e.call_id)).size,20)
  assert.ok(state.entries.every(e=>e.state==='reserved'&&f.agents.includes(e.agent_id)))
  // Fetch each accepted caller again so every reserved caller receives its own
  // Dial exactly once, even when another ingress request dispatched its entry.
  for(const entry of state.entries){
   const record=await f.read('/api/handset/records/'+entry.call_id)
   const call=calls.find(c=>record.record.source_id===source.source.id+':queue:'+c.CallSid)
   assert.ok(call,'each entry retains one of the signed surge source identities')
   assert.equal(JSON.parse(record.record.data).from,call.From)
   assert.equal(JSON.parse(record.record.data).to,call.To)
   assert.equal(record.record.source_id,source.source.id+':queue:'+call.CallSid)
  }
  for(const [i,call] of calls.entries()){
   if(!instructions[i].body.includes('<Dial')){
    const r=await f.edge.callback(call);assert.equal(r.status,200);instructions[i].body=await r.text()
   }
   assert.match(instructions[i].body,/<Dial /)
  }
  state=await f.read()
  assert.equal(state.offers.length,20)
  assert.equal(state.capacity[0].pending,20);assert.equal(state.capacity[0].remaining,0)
  for(const offer of state.offers){
   assert.equal(offer.source_id,source.source.id);assert.equal(offer.binding_id,f.binding.id)
   assert.equal(offer.destination,f.destinations[offer.agent_id]);assert.equal(offer.state,'uncertain')
   assert.ok(calls.some(c=>c.CallSid===offer.parent_call_sid))
  }
  const accepted=state.entries,reservations=state.reservations,offers=state.offers
  const surgeMs=performance.now()-surgeStart,refusalStart=performance.now()
  const refused=await Promise.all(Array.from({length:20},(_,i)=>f.edge.callback(f.edge.resource(240+i))))
  for(const response of refused){
   assert.equal(response.status,200,await response.clone().text())
   const body=await response.text();assert.match(body,/<Say[^>]*>[^<]+<\/Say><Hangup\/>/)
   assert.ok(!body.includes('<Dial')&&!body.includes('<Redirect'))
  }
  const refusalMs=performance.now()-refusalStart
  state=await f.read()
  assert.deepEqual(state.entries,accepted);assert.deepEqual(state.reservations,reservations);assert.deepEqual(state.offers,offers)
  const manual=await f.write('/api/handset/records',{kind:'call_session',sourceId:'synthetic-handset-2400',occurredAt:Date.now(),data:{direction:'inbound',state:'unknown'}},201)
  const denied=await f.write(f.base+'/'+f.queue.id+'/entries',{callId:manual.record.id,language:'en'},409)
  assert.equal(denied.error,'queue_capacity_exceeded');assert.equal(denied.detail.limit,20);assert.equal(denied.detail.occupied,20)
  // A connected call retains its independent slot while the pending budget
  // admits just one winner from another concurrent surge at the boundary.
  const activeOffer=offers.find(o=>o.parent_call_sid===calls[0].CallSid)
  const child=f.edge.child(500,calls[0],activeOffer.destination,'in-progress',{date_created:new Date(activeOffer.emitted_at).toUTCString()})
  assert.equal((await f.edge.status(activeOffer,child)).status,204)
  state=await f.read();assert.equal(state.entries.find(e=>e.id===activeOffer.entry_id).state,'active')
  const activeReservation=state.reservations.find(r=>r.entry_id===activeOffer.entry_id)
  assert.equal(state.capacity[0].remaining,1)
  const boundary=await Promise.all(Array.from({length:20},(_,i)=>f.edge.callback(f.edge.resource(280+i))))
  const endings=await Promise.all(boundary.map(async response=>{assert.equal(response.status,200,await response.clone().text());return response.text()}))
  assert.equal(endings.filter(body=>body.includes('<Dial ')).length,1)
  assert.equal(endings.filter(body=>body.includes('<Hangup/>')).length,19)
  state=await f.read()
  assert.equal(state.entries.length,21);assert.equal(state.reservations.length,21);assert.equal(state.offers.length,21)
  assert.equal(state.capacity[0].pending,20);assert.equal(state.capacity[0].remaining,0)
  assert.deepEqual(state.reservations.find(r=>r.entry_id===activeOffer.entry_id),activeReservation)
  assert.equal(new Set(state.reservations.map(r=>r.agent_id+':'+r.slot)).size,21)
  const retained=state
  await runtime.restart()
  state=await f.read()
  assert.deepEqual(state.entries,retained.entries);assert.deepEqual(state.reservations,retained.reservations);assert.deepEqual(state.offers,retained.offers)
  const replay=await f.edge.callback(calls[1]);assert.equal(replay.status,200);assert.ok(!(await replay.text()).includes('<Dial'))
  assert.equal((await f.read()).offers.length,21)
  await f.write(f.base+'/sources/revoke',{bindingId:f.binding.id})
  assert.equal((await f.edge.callback(f.edge.resource(320))).status,403)
  assert.equal((await f.edge.callback(calls[1])).status,403,'revocation fences retained callers as well as fresh admission')
  state=await f.read()
  assert.deepEqual(state.entries,retained.entries);assert.deepEqual(state.reservations,retained.reservations);assert.deepEqual(state.offers,retained.offers)
  assert.ok(runtime.sourceRequests.every(r=>r.method==='GET'),'qualification creates no paid outbound API effects')
  t.diagnostic(JSON.stringify({people:200,agents:100,concurrentInbound:20,accepted:20,refused:20,boundaryAccepted:1,boundaryRefused:19,retainedReservations:21,configuredMs:Math.round(configuredMs),surgeMs:Math.round(surgeMs),refusalMs:Math.round(refusalMs),hostedCarrierCapacity:'unmeasured'}))
 }finally{await runtime.close()}
})

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
  const visits=state.visits.filter(v=>v.entry_id===target.id).sort((a,b)=>a.ordinal-b.ordinal)
  assert.equal(visits.length,2);assert.equal(visits[0].queue_id,overflow.id);assert.equal(visits[0].state,'overflow');assert.equal(visits[1].queue_id,f.support.id)
  assert.notEqual(visits[0].id,visits[1].id);assert.equal(state.entries.find(e=>e.id===target.id).origin_queue_id,overflow.id)
  const cycle=await post(runtime,f.base+'/'+f.support.id+'/configure',{name:f.support.name,skills:[],maxWaitSeconds:30,wrapSeconds:10,maxWaiting:100,overflowKind:'queue',overflowQueueId:overflow.id,revision:f.support.revision,confirm:'approve native queue policy'},f.headers)
  assert.equal(cycle.status,400)
  assert.equal((await runtime.request(f.base)).status,401)
  assert.equal((await post(runtime,f.base+'/presence',{operatorId:f.english,availability:'available',revision:1},{...f.headers,origin:'https://synthetic-handset-999.example.test'})).status,403)
  await runtime.sql("UPDATE oa_operators SET status='active' WHERE id='synthetic-handset-2'")
  const member=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  assert.equal((await runtime.request(f.base,{headers:{cookie:member.cookie}})).status,403)
  const agentCookie=(await signIn({...runtime,ownerEmail:f.spanish+'@example.test'})).cookie
  const self=async()=> (await runtime.request(f.base+'/self',{headers:{cookie:agentCookie}})).json()
  let own=await self()
  assert.equal(own.agent.operator_id,f.spanish);assert.ok(!('entries' in own))
  for(const [q,loggedIn] of [[f.sales,0],[f.support,1]]){
   const m=(await self()).memberships.find(m=>m.queue_id===q.id)
   assert.equal((await post(runtime,f.base+'/'+q.id+'/memberships',{operatorId:f.spanish,loggedIn,revision:m.revision},{cookie:agentCookie})).status,200)
  }
  own=await self();assert.equal(own.memberships.find(m=>m.queue_id===f.sales.id).logged_in,0);assert.equal(own.memberships.find(m=>m.queue_id===f.support.id).logged_in,1)
  assert.equal((await post(runtime,f.base+'/presence',{availability:'away',revision:own.agent.revision},{cookie:agentCookie})).status,200)
  own=await self();assert.equal(own.agent.availability,'away')
  assert.equal((await post(runtime,f.base+'/wrap',{seconds:45,revision:own.agent.revision},{cookie:agentCookie})).status,200)
  assert.ok((await self()).agent.wrap_until>Date.now())
  assert.equal((await post(runtime,f.base+'/presence',{operatorId:f.english,availability:'offline',revision:1},{cookie:agentCookie})).status,403)
  assert.equal((await post(runtime,f.base+'/'+f.sales.id+'/memberships',{operatorId:f.english,loggedIn:0,revision:1},{cookie:agentCookie})).status,403)
  assert.equal((await post(runtime,f.base+'/agents',{operatorId:f.spanish,capacity:10},{cookie:agentCookie})).status,403)

 }finally{await runtime.close()}
})

test('A signed twenty-call surge emits exact Spanish-skilled Dial targets, verifies bridge readback and continues the approved overflow route',async()=>{
 const runtime=await openHandset({twilio:true})
 try{
  const source=await sourceFixture(runtime),f=await queueFixture(runtime,source.cookie)
  assert.equal((await post(runtime,f.base+'/sources',{sourceId:source.source.id,queueId:f.sales.id,language:'en',spanishDigit:'2',confirm:'authorize signed inbound queue routing'},f.headers)).status,409,'activation refuses an absent selected overflow route')
  const media=await authorizeQueueMedia(f,source),{binding,edge,destinations}=media
  const calls=Array.from({length:20},(_,i)=>({...edge.resource(i),...(i%2?{}:{Digits:'2'})}))
  const dialed=[]
  for(const call of calls){
   const response=await edge.callback(call)
   assert.equal(response.status,200,await response.clone().text())
   const twiml=await response.text()
   assert.match(twiml,/<Response><Say language="(?:es-MX|en-US)">/)
   if(twiml.includes('<Dial'))dialed.push({call,twiml})
   else assert.match(twiml,/<Redirect method="POST">/)
  }
  let state=await f.read()
  assert.equal(state.entries.length,20);assert.equal(state.reservations.length,2)
  assert.equal(dialed.length,2)
  assert.ok(dialed[0].twiml.includes('>'+destinations[f.spanish]+'</Sip>'),'Spanish IVR choice dials the exact Spanish-skilled agent first')
  assert.ok(dialed[1].twiml.includes('>'+destinations[f.english]+'</Sip>'))
  assert.equal(state.announcements.length,20)
  assert.ok(state.announcements.every(a=>a.delivery_state==='pending'))
  assert.ok(state.offers.every(o=>o.state==='uncertain'),'emitting Dial never fabricates an answered call')
  const spanish=state.offers.find(o=>o.agent_id===f.spanish),english=state.offers.find(o=>o.agent_id===f.english)
  assert.equal((await post(runtime,f.base+'/entries/'+spanish.entry_id+'/accept',{revision:state.entries.find(e=>e.id===spanish.entry_id).revision},f.headers)).status,409)
  // Callback labels cannot advance a call when the authoritative child GET
  // has a foreign parent, destination, or still-ringing status.
  await runtime.sql('UPDATE hnd_queue_offers SET emitted_at=emitted_at-10000 WHERE id=?',spanish.id)
  let sid=edge.child(0,calls[0],destinations[f.spanish],'in-progress',{parent_call_sid:'synthetic-handset-999'})
  assert.equal((await edge.status(spanish,sid)).status,502)
  sid=edge.child(0,calls[0],destinations[f.english],'in-progress')
  assert.equal((await edge.status(spanish,sid)).status,502)
  sid=edge.child(0,calls[0],destinations[f.spanish],'ringing')
  assert.equal((await edge.status(spanish,sid,{CallStatus:'in-progress'})).status,204)
  state=await f.read();assert.equal(state.entries.find(e=>e.id===spanish.entry_id).state,'reserved')
  edge.child(0,calls[0],destinations[f.spanish],'in-progress')
  assert.equal((await edge.status(spanish,sid,{CallStatus:'ringing'})).status,204)
  state=await f.read();assert.equal(state.entries.find(e=>e.id===spanish.entry_id).state,'active')
  assert.equal(state.reservations.find(r=>r.entry_id===spanish.entry_id).state,'active')
  const canonical=(await runtime.sql('SELECT r.* FROM hnd_records r JOIN hnd_source_objects o ON o.record_id=r.id WHERE o.source_id=? AND o.external_id=?',source.source.id,sid)).results[0]
  assert.equal(canonical.kind,'call_leg');assert.equal(canonical.parent_id,state.entries.find(e=>e.id===spanish.entry_id).call_id)
  edge.child(0,calls[0],destinations[f.spanish],'completed')
  assert.equal((await edge.status(spanish,sid)).status,204)
  state=await f.read()
  const completed=state.offers.find(o=>o.id===spanish.id)
  assert.equal(completed.state,'completed');assert.ok(completed.service_seconds>0)
  assert.equal(state.agents.find(a=>a.operator_id===f.spanish).wrapping,true)
  const receipt=await edge.action(completed);assert.equal(receipt.status,200);assert.match(await receipt.text(),/<Hangup\/>/)
  assert.equal((await edge.status(spanish,sid)).status,204,'duplicate terminal callback reconciles without another completion')
  assert.equal((await runtime.sql('SELECT count(*) AS n FROM hnd_queue_service_observations WHERE offer_id=?',spanish.id)).results[0].n,1)
  const reservedAfter=(await f.read()).reservations.length
  assert.equal((await edge.callback({...calls[1],CallStatus:'completed'})).status,200)
  assert.equal((await f.read()).reservations.length,reservedAfter,'a forged terminal parameter cannot abandon an actually live parent')
  edge.parent(calls[1],{status:'completed',end_time:new Date().toUTCString(),duration:'0'})
  assert.equal((await edge.callback({...calls[1],CallStatus:'completed'})).status,200)
  state=await f.read();assert.equal(state.reservations.length,0);assert.equal(counts(state,'abandoned'),1)
  await runtime.sql("UPDATE hnd_queue_entries SET deadline_at=? WHERE state IN ('waiting','reserved')",Date.now()-1)
  await f.write(f.base+'/reconcile',{})
  const overflow=await edge.callback(calls[2]);assert.equal(overflow.status,200)
  const xml=await overflow.text();assert.ok(xml.includes('<Redirect method="POST">'+media.overflowUrl+'</Redirect>'));assert.ok(!xml.includes('<Hangup'))
  state=await f.read();assert.equal(counts(state,'overflow'),18)
  const newCall={...edge.resource(40),Digits:'2'},estimate=await edge.callback(newCall)
  assert.equal(estimate.status,200)
  assert.match(await estimate.text(),/aproximada/)
  state=await f.read()
  assert.ok(state.announcements.some(a=>a.estimated_wait_seconds>0&&a.estimate_samples>0),'qualified estimate derives only from measured completed provider service')
  assert.ok(runtime.sourceRequests.every(r=>r.method==='GET'),'Dial is an official TwiML instruction; no API call creation is invented')
  const before=state.entries.length
  assert.equal((await edge.callback(edge.resource(50),{signature:false})).status,403)
  assert.equal((await edge.callback(edge.resource(51),{signedOrigin:'https://synthetic-handset-999.example.test'})).status,403)
  assert.equal((await edge.callback({...edge.resource(52),AccountSid:'synthetic-handset-999'})).status,403)
  assert.equal((await edge.callback({...edge.resource(53),To:'+15125550199'})).status,403)
  assert.equal((await f.read()).entries.length,before)
  // A caller entering Sales follows its selected queue overflow while this
  // agent is logged out there and independently logged into Support.
  await f.changeMembership(f.sales,f.english,0)
  const currentSales=(await f.read()).queues.find(q=>q.id===f.sales.id)
  await f.write(f.base+'/'+f.sales.id+'/configure',{name:currentSales.name,mode:'longest_idle',skills:[],maxWaitSeconds:120,wrapSeconds:30,maxWaiting:100,overflowKind:'queue',overflowQueueId:f.support.id,revision:currentSales.revision,confirm:'approve native queue policy'})
  const receivingCall=edge.resource(55)
  let instructions=''
  for(let step=0;step<3;step++){
   const response=await edge.callback(receivingCall)
   assert.equal(response.status,200,await response.clone().text());instructions=await response.text()
   if(instructions.includes('<Dial'))break
   const continuation=instructions.match(/<Redirect method="POST">([^<]+)<\/Redirect>/)
   assert.ok(continuation,'a pending receiving-queue dispatch gives the caller a continuation')
   assert.equal(new URL(continuation[1].replaceAll('&amp;','&')).pathname,binding.callbackPath)
  }
  assert.ok(instructions.includes('>'+destinations[f.english]+'</Sip>'),'the signed caller reaches the eligible receiving-queue agent')
  const routed=await f.read(),offer=routed.offers.find(o=>o.parent_call_sid===receivingCall.CallSid)
  assert.ok(offer)
  const entry=routed.entries.find(e=>e.id===offer.entry_id)
  assert.equal(entry.queue_id,f.support.id)
  const visits=routed.visits.filter(v=>v.entry_id===entry.id)
  assert.equal(visits.length,2);assert.notEqual(visits[0].id,visits[1].id)

  // Every waiting and new caller receives a native, bounded ending when the
  // selected route is revoked. Never answer a caller's Voice URL with a 409.
  await f.presence(f.english,'busy');await f.presence(f.spanish,'busy')
  const waiting=[]
  for(let n=80;n<83;n++){const c=edge.resource(n);assert.equal((await edge.callback(c)).status,200);waiting.push(c)}
  await f.write(f.base+'/overflow/'+f.support.id+'/route/revoke',{})
  for(const c of [...waiting,edge.resource(84)]){
   const r=await edge.callback(c);assert.equal(r.status,200,await r.clone().text());assert.match(await r.text(),/<Say[^>]*>[^<]+<\/Say><Hangup\/>/)
  }
  const alerts=(await f.read()).alerts
  assert.ok(alerts.length>=4);assert.ok(alerts.every(a=>a.reason==='overflow_route_unavailable'))
  const alertCount=alerts.length
  await edge.callback(waiting[0]);assert.equal((await f.read()).alerts.length,alertCount,'replay retains one owner alert per call')
  await f.write(f.base+'/sources/revoke',{bindingId:binding.id})
  assert.equal((await edge.callback(calls[3])).status,403)
  const audit=await (await runtime.request('/api/handset/audit/export',{headers:f.headers})).json()
  assert.ok(audit.rows.some(r=>r.action==='source.refuse'&&r.outcome==='refused'))
  // Changing only an approver profile version does not revoke exact routes.
  await runtime.sql("UPDATE oa_operators SET display_name='Mara Patel Updated',version=version+1 WHERE id=?",f.english)
  const renewed=(await signIn(runtime)).cookie
  const refreshed=await (await runtime.request(f.base,{headers:{cookie:renewed}})).json()
  assert.ok(refreshed.agentRoutes.every(r=>!r.suspended))
  await runtime.sql("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES ('synthetic-handset-619','synthetic-handset-619@example.test','Casey Rivera','owner','active',?)",Date.now())
  await runtime.sql("UPDATE oa_operators SET role='member',version=version+1 WHERE id=?",f.english)
  const replacement=(await signIn({...runtime,ownerEmail:'synthetic-handset-619@example.test'})).cookie
  const suspended=await (await runtime.request(f.base,{headers:{cookie:replacement}})).json()
  assert.ok(suspended.agentRoutes.every(r=>r.suspended===1));assert.ok(suspended.overflowRoutes.every(r=>r.suspended===1))
 }finally{await runtime.close()}
})

test('A lost Dial response is never replayed after restart; verified active calls survive logout and maximum wait cancels only an unanswered child once',async()=>{
 const runtime=await openHandset({twilio:true})
 try{
  const source=await sourceFixture(runtime),f=await queueFixture(runtime,source.cookie),media=await authorizeQueueMedia(f,source),{edge,destinations}=media
  const call={...edge.resource(60),Digits:'2'}
  const initial=await edge.callback(call);assert.equal(initial.status,200);assert.match(await initial.text(),/<Dial /)
  let state=await f.read(),offer=state.offers[0]
  await runtime.restart()
  const repeated=await edge.callback(call);assert.equal(repeated.status,200);assert.ok(!(await repeated.text()).includes('<Dial'))
  await runtime.sql('UPDATE hnd_queue_reservations SET lease_until=? WHERE entry_id=?',Date.now()-1,offer.entry_id)
  await f.write(f.base+'/reconcile',{})
  state=await f.read();assert.equal(state.reservations.length,1);assert.equal(state.offers.length,1);assert.equal(state.offers[0].state,'uncertain')
  await runtime.sql('UPDATE hnd_queue_offers SET emitted_at=emitted_at-10000 WHERE id=?',offer.id)
  const sid=edge.child(10,call,destinations[f.spanish],'in-progress')
  await f.write(f.base+'/offers/'+offer.id+'/reconcile',{})
  state=await f.read();assert.equal(state.entries.find(e=>e.id===offer.entry_id).state,'active')
  const supervision='/api/handset/supervision',grant=async q=>{
   const response=await post(runtime,supervision+'/grants',{operatorId:f.english,queueId:q.id,canIntervene:true,expiresAt:Date.now()+3600000,confirm:'approve supervision scope'},f.headers)
   assert.equal(response.status,201,await response.clone().text());return response.json()
  }
  await grant(f.support)
  let requests=runtime.sourceRequests.length
  for(const operation of ['listen','whisper','barge','takeover'])assert.equal((await post(runtime,supervision+'/queues/'+f.sales.id+'/calls/'+offer.entry_id+'/'+operation,{},f.headers)).status,403)
  assert.equal(runtime.sourceRequests.length,requests,'foreign-team control refuses before the official provider edge')
  const salesScope=await grant(f.sales)
  for(const [availability,reason] of [['away','Supervisor coaching break'],['available','Coaching complete']]){
   const agent=state.agents.find(a=>a.operator_id===f.spanish)
   const changed=await post(runtime,supervision+'/queues/'+f.sales.id+'/agents/'+f.spanish+'/state',{availability,revision:agent.revision,reason},f.headers)
   assert.equal(changed.status,200,await changed.clone().text())
   state=await f.read()
   assert.equal(state.agents.find(a=>a.operator_id===f.spanish).availability,availability)
   assert.equal(state.entries.find(e=>e.id===offer.entry_id).state,'active','supervision preserves a provider-read-back active call')
   assert.equal(state.offers.find(o=>o.id===offer.id).state,'active')
  }
  requests=runtime.sourceRequests.length
  const held=await post(runtime,supervision+'/queues/'+f.sales.id+'/calls/'+offer.entry_id+'/whisper',{},f.headers)
  assert.equal(held.status,409);assert.equal((await held.json()).error,'supervision_media_qualification_held')
  assert.equal(runtime.sourceRequests.length,requests,'an explicit team grant still cannot invent qualified whisper audio')
  assert.equal((await post(runtime,supervision+'/grants/'+salesScope.id+'/revoke',{},f.headers)).status,200)
  for(const operation of ['listen','whisper','barge','takeover'])assert.equal((await post(runtime,supervision+'/queues/'+f.sales.id+'/calls/'+offer.entry_id+'/'+operation,{},f.headers)).status,403)
  assert.equal(runtime.sourceRequests.length,requests,'revoked authority makes no provider attempt')
  await f.changeMembership(f.sales,f.spanish,0);await f.presence(f.spanish,'offline')
  state=await f.read()
  assert.equal(state.memberships.find(m=>m.queue_id===f.support.id&&m.operator_id===f.spanish).logged_in,1)
  assert.equal(state.entries.find(e=>e.id===offer.entry_id).state,'active')
  assert.equal((await post(runtime,f.base+'/entries/'+offer.entry_id+'/complete',{revision:state.entries.find(e=>e.id===offer.entry_id).revision},f.headers)).status,409)
  const loggedOut={...edge.resource(61),Digits:'2'},overflow=await edge.callback(loggedOut)
  assert.equal(overflow.status,200);assert.ok((await overflow.text()).includes(media.overflowUrl))
  assert.equal((await f.read()).entries.find(e=>e.id===offer.entry_id).state,'active')
  edge.child(10,call,destinations[f.spanish],'completed')
  assert.equal((await edge.status(offer,sid)).status,204)
  await f.changeMembership(f.sales,f.spanish,1);await f.presence(f.spanish)
  const next={...edge.resource(62),Digits:'2'},wrapped=await edge.callback(next)
  assert.equal(wrapped.status,200);assert.ok(!(await wrapped.text()).includes('<Dial'))
  await runtime.sql('UPDATE hnd_queue_agents SET wrap_until=?,heartbeat_at=? WHERE operator_id=?',Date.now()-1,Date.now(),f.spanish)
  const dial=await edge.callback(next);assert.equal(dial.status,200);assert.match(await dial.text(),/<Dial /)
  state=await f.read();offer=state.offers.find(o=>o.state==='uncertain')
  await runtime.sql('UPDATE hnd_queue_offers SET emitted_at=emitted_at-10000 WHERE id=?',offer.id)
  const ringingSid=edge.child(11,next,destinations[f.spanish],'ringing')
  assert.equal((await edge.status(offer,ringingSid)).status,204)
  await runtime.sql('UPDATE hnd_queue_entries SET deadline_at=? WHERE id=?',Date.now()-1,offer.entry_id)
  await f.write(f.base+'/offers/'+offer.id+'/reconcile',{})
  await f.write(f.base+'/offers/'+offer.id+'/reconcile',{})
  const cancels=runtime.sourceRequests.filter(r=>r.method==='POST'&&r.url.endsWith('/'+ringingSid+'.json'))
  assert.equal(cancels.length,1,'uncertain cancellation acknowledgment never causes another provider POST')
  state=await f.read();assert.equal(state.entries.find(e=>e.id===offer.entry_id).state,'reserved')
  edge.child(11,next,destinations[f.spanish],'canceled')
  await f.write(f.base+'/offers/'+offer.id+'/reconcile',{})
  const continued=await edge.action({...offer,child_call_sid:ringingSid},{DialCallStatus:'canceled',DialBridged:'false'})
  assert.equal(continued.status,200);assert.ok((await continued.text()).includes(media.overflowUrl))
  state=await f.read();assert.equal(state.reservations.length,0)
  assert.equal(state.entries.find(e=>e.id===offer.entry_id).state,'overflow')
  assert.equal((await runtime.sql("SELECT count(*) AS n FROM hnd_queue_events WHERE entry_id=? AND type='offer.emitted'",offer.entry_id)).results[0].n,1)
  assert.equal((await post(runtime,f.base+'/agents/'+f.spanish+'/route',{sourceId:source.source.id,kind:'sip',destination:'sip:synthetic-handset-999:synthetic-handset-998@synthetic-handset-997.example.test',revision:1,confirm:'approve exact queue agent route'},f.headers)).status,400)
  assert.equal((await post(runtime,f.base+'/overflow/'+f.sales.id+'/route',{url:'https://synthetic-handset-999.example.test/voicemail?synthetic-handset-998',revision:1,confirm:'approve exact queue overflow route'},f.headers)).status,400)
 }finally{await runtime.close()}
})

test('Native flow drafts require every branch test and exact publication approval while rollback retains versions',async()=>{
 const runtime=await openHandset()
 try{
  const q=await queueFixture(runtime),base='/api/handset/flows',headers=q.headers
  async function send(path,value,status=200){const r=await post(runtime,base+path,value,headers);assert.equal(r.status,status,await r.clone().text());return r.json()}
  const definition={name:'Austin bilingual reception',entry:'hours',timezone:'America/Chicago',overrides:[{date:'2026-11-01',entry:'after'}],nodes:[{id:'hours',kind:'hours',next:['menu','after']},{id:'menu',kind:'menu',next:['sales','after']},{id:'sales',kind:'queue',queueId:q.sales.id,language:'en',next:[]},{id:'after',kind:'receptionist',language:'es',next:[]}]}
  const first=await send('',{definition},201),confirm='approve this exact tested flow version'
  await send('/'+first.id+'/publish',{revision:0,confirm},409)
  await send('/'+first.id+'/test',{path:['hours','menu','sales']})
  await send('/'+first.id+'/test',{path:['hours','after']})
  await send('/'+first.id+'/publish',{revision:0,confirm},409)
  assert.equal((await send('/'+first.id+'/test',{path:['hours','menu','after']})).state,'tested')
  await send('/'+first.id+'/publish',{revision:0,confirm:'approve something else'},403)
  const publication=await send('/'+first.id+'/publish',{revision:0,confirm});assert.equal(publication.approvedBy,'synthetic-handset-1');assert.equal(publication.liveRouting,false)
  const active=await q.admit(q.sales);await q.write(q.base+'/'+q.sales.id+'/dispatch',{});await q.action(active.id,'accept')
  const second=await send('',{flowId:first.flowId,previousVersionId:first.id,definition:{...definition,name:'Revised reception'}},201)
  let snapshot=await (await runtime.request(base,{headers})).json();assert.equal(snapshot.publications[0].version_id,first.id,'draft has no live publication change')
  for(const path of [['hours','menu','sales'],['hours','after'],['hours','menu','after']])await send('/'+second.id+'/test',{path})
  await send('/'+second.id+'/publish',{revision:0,confirm},409)
  snapshot=await (await runtime.request(base,{headers})).json();assert.equal(snapshot.publications[0].version_id,first.id);assert.equal(snapshot.publications[0].revision,1)
  await send('/'+second.id+'/publish',{revision:1,confirm});await send('/'+first.id+'/rollback',{revision:1,confirm},409)
  await send('/'+first.id+'/rollback',{revision:2,confirm});await runtime.restart()
  snapshot=await (await runtime.request(base,{headers})).json();assert.equal(snapshot.publications[0].version_id,first.id);assert.equal(snapshot.publications[0].revision,3)
  assert.equal(snapshot.versions.find(v=>v.id===second.id).state,'retired');assert.equal((await q.read()).entries.find(e=>e.id===active.id).state,'active','native publication never mutates existing queue calls')
  const audit=await runtime.sql("SELECT action FROM hnd_audit WHERE action LIKE 'flow.%'");assert.ok(audit.results.some(r=>r.action==='flow.rollback'))
  assert.deepEqual(JSON.parse(snapshot.versions.find(v=>v.id===first.id).definition),definition)
  const retained=await runtime.sql("SELECT a.subject,a.actor,r.operator_id FROM hnd_audit a JOIN hnd_actor_refs r ON r.pseudonym=a.actor WHERE a.action='flow.rollback' AND a.outcome='completed'");assert.equal(retained.results.length,1);assert.equal(retained.results[0].subject,first.id);assert.equal(retained.results[0].operator_id,'synthetic-handset-1')
 }finally{await runtime.close()}
})

test('Native flow authoring refuses malformed graphs stale drafts and unauthorized publication',async()=>{
 const runtime=await openHandset()
 try{
  const {cookie}=await signIn(runtime),headers={cookie},base='/api/handset/flows'
  const valid={name:'Reception',entry:'menu',timezone:'America/Chicago',overrides:[],nodes:[{id:'menu',kind:'menu',next:['english','spanish']},{id:'english',kind:'end',language:'en',next:[]},{id:'spanish',kind:'end',language:'es',next:[]}]}
  for(const transform of [d=>d.nodes[0].next=['menu','english'],d=>d.nodes[0].next=[],d=>d.nodes[0].next=['english','absent'],d=>d.nodes.push({id:'unreachable',kind:'end',language:'es',next:[]}),d=>d.nodes[0].emergencyInterception=true,d=>d.overrides=[{date:'2026-02-30',entry:'english'}],d=>d.nodes[0].kind='emergency']){
   const bad=structuredClone(valid);transform(bad);const r=await post(runtime,base,{definition:bad},headers);assert.equal(r.status,400,await r.clone().text())
  }
  const first=await (await post(runtime,base,{definition:valid},headers)).json()
  const next=await post(runtime,base,{flowId:first.flowId,previousVersionId:first.id,definition:valid},headers);assert.equal(next.status,201)
  assert.equal((await post(runtime,base,{flowId:first.flowId,previousVersionId:first.id,definition:valid},headers)).status,409)
  assert.equal((await post(runtime,base+'/'+first.id+'/test',{path:['menu']},headers)).status,400)
  assert.equal((await runtime.request(base)).status,401)
  await runtime.sql("UPDATE oa_operators SET status='active' WHERE id='synthetic-handset-2'")
  const member=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  assert.equal((await post(runtime,base,{definition:valid},{cookie:member.cookie})).status,403)
  assert.equal((await runtime.request(base,{headers:{cookie:member.cookie}})).status,403)
  const foreign=await runtime.request(base,{method:'POST',headers:{cookie,origin:'https://synthetic-handset-foreign.example.test','content-type':'application/json'},body:JSON.stringify({definition:valid})});assert.equal(foreign.status,403)
 }finally{await runtime.close()}
})

test('Native scenario evaluation applies local hours holiday overrides and both DST transitions without publishing or routing',async()=>{
 const runtime=await openHandset()
 try{
  const f=await queueFixture(runtime),base='/api/handset/flows'
  const definition={name:'Chicago hours',entry:'hours',timezone:'America/Chicago',overrides:[{date:'2026-11-26',entry:'after'}],nodes:[{id:'hours',kind:'hours',hours:{weekly:[{days:[1,2,3,4,5,6,7],startMinute:90,endMinute:150}]},next:['sales','after']},{id:'sales',kind:'queue',queueId:f.sales.id,next:[]},{id:'after',kind:'receptionist',next:[]}]}
  const create=await post(runtime,base,{definition},f.headers);assert.equal(create.status,201,await create.clone().text());const version=await create.json()
  async function evaluate(instant,terminal,localMinute,overrideApplied=false){const r=await post(runtime,base+'/'+version.id+'/evaluate',{instant},f.headers);assert.equal(r.status,200,await r.clone().text());const d=await r.json();assert.equal(d.terminal.id,terminal);assert.equal(d.localMinute,localMinute);assert.equal(d.overrideApplied,overrideApplied);assert.equal(d.versionId,version.id);assert.equal(d.liveRouting,false)}
  await evaluate('2026-03-08T07:29:59Z','after',89)
  await evaluate('2026-03-08T07:30:00Z','sales',90)
  await evaluate('2026-03-08T07:59:59Z','sales',119)
  await evaluate('2026-03-08T08:00:00Z','after',180)
  await evaluate('2026-11-01T06:45:00Z','sales',105)
  await evaluate('2026-11-01T07:45:00Z','sales',105)
  await evaluate('2026-11-26T07:45:00Z','after',105,true)
  assert.equal((await post(runtime,base+'/'+version.id+'/evaluate',{instant:'2026-11-01T01:45:00'},f.headers)).status,400)
  assert.equal((await post(runtime,base+'/'+version.id+'/evaluate',{instant:'2026-02-30T01:45:00Z'},f.headers)).status,400)
  const snapshot=await (await runtime.request(base,{headers:f.headers})).json();assert.equal(snapshot.publications.length,0);assert.equal(snapshot.versions[0].state,'draft');assert.equal(runtime.sourceRequests.length,0)
  await runtime.sql("UPDATE oa_sessions SET revoked_at=? WHERE operator_id='synthetic-handset-1'",Date.now())
  assert.equal((await post(runtime,base+'/'+version.id+'/evaluate',{instant:'2026-11-01T07:45:00Z'},f.headers)).status,401)
 }finally{await runtime.close()}
})

test('Native group scenarios select simultaneous sequential round robin and longest idle eligible members without granting call authority',async()=>{
 const runtime=await openHandset()
 try{
  const f=await queueFixture(runtime),base='/api/handset/flows',members=[f.english,f.spanish]
  for(const strategy of ['simultaneous','sequential','round_robin','longest_idle']){
   const definition={name:strategy,entry:'sales',timezone:'America/Chicago',overrides:[],nodes:[{id:'sales',kind:'queue',queueId:f.sales.id,next:[],group:{strategy,members}}]}
   const created=await post(runtime,base,{definition},f.headers);assert.equal(created.status,201,await created.clone().text());const v=await created.json(),instant='2026-11-02T16:00:00Z'
   const states=members.map((id,i)=>({id,eligible:true,idleSince:i?'2026-11-02T14:00:00Z':'2026-11-02T15:00:00Z'}))
   const run=async(state,status=200)=>{const r=await post(runtime,base+'/'+v.id+'/evaluate',{instant,groups:{sales:state}},f.headers);assert.equal(r.status,status,await r.clone().text());return r.json()}
   const selected=await run({members:states,cursor:1});assert.deepEqual(selected.group.selected,strategy==='simultaneous'?members:strategy==='sequential'?[f.english]:[f.spanish]);assert.equal(selected.liveRouting,false)
   const unavailable=await run({members:states.map(m=>({...m,eligible:false})),cursor:1});assert.deepEqual(unavailable.group.selected,[])
   await run({members:states.slice(1),cursor:1},400)
   if(strategy==='round_robin'){const next=await run({members:states,cursor:selected.group.nextCursor});assert.deepEqual(next.group.selected,[f.english]);await run({members:states},400)}
  }
  assert.equal(runtime.sourceRequests.length,0)
 }finally{await runtime.close()}
})

test('Scoped flow roles separate read draft and test authority, fence foreign references and withdraw access without changing exact publication',async()=>{
 const {flowRoleFixture}=await import('./helpers/handset-flow-access.mjs'),runtime=await openHandset()
 try{
  const q=await queueFixture(runtime),f=await flowRoleFixture(runtime,q),{base,access,allowed,foreign}=f
  const read=()=>runtime.request(base,{headers:f.headers}),save=d=>f.actorPost(base,{flowId:allowed.flowId,previousVersionId:allowed.id,definition:d})
  assert.equal((await read()).status,403)
  let role=await f.ownerPost(access,{...f.roleInput,capabilities:['flow.read']},201)
  await f.assign(role)
  let catalog=await (await read()).json()
  assert.deepEqual(catalog.versions.map(v=>v.id),[allowed.id]);assert.deepEqual(catalog.publications,[]);assert.deepEqual(catalog.tests,[])
  assert.equal((await save(f.definition)).status,403)
  assert.equal((await f.actorPost(`${base}/${allowed.id}/test`,{path:['sales']})).status,403)
  assert.equal((await f.actorPost(`${base}/${allowed.id}/evaluate`,{instant:'2026-10-27T18:00:00Z'})).status,403)
  role=await f.ownerPost(`${access}/${role.id}`,{...f.roleInput,revision:role.revision},201)
  assert.equal((await read()).status,403,'changed role suspends the previous exact assignment')
  await f.assign(role)
  for(const d of [
   {...f.definition,nodes:[{...f.definition.nodes[0],queueId:q.support.id}]},
   {...f.definition,nodes:[{...f.definition.nodes[0],group:{strategy:'simultaneous',members:[q.english]}}]},
   {...f.definition,nodes:[{...f.definition.nodes[0],prompt:{promptId:crypto.randomUUID(),versionId:crypto.randomUUID()}}]},
  ])assert.equal((await save(d)).status,403,'a flow role never imports another reference')
  for(const action of ['test','evaluate','publish','rollback'])assert.equal((await f.actorPost(`${base}/${foreign.id}/${action}`,{path:['support'],revision:1,confirm:'approve this exact tested flow version'})).status,403)
  assert.equal((await f.actorPost(base,{definition:f.definition})).status,403,'scoped authors cannot create unscoped flows')
  assert.equal((await f.actorPost(base,{flowId:foreign.flowId,previousVersionId:foreign.id,definition:f.definition})).status,403)
  assert.equal((await f.actorPost(access,f.roleInput)).status,403,'scoped preparation grants no role administration')
  const response=await save({...f.definition,name:'Austin reviewed draft'});assert.equal(response.status,201);const draft=await response.json()
  assert.equal((await save(f.definition)).status,409,'immutable draft versions reject stale saves')
  assert.equal((await f.actorPost(`${base}/${draft.id}/test`,{path:['sales']})).status,200)
  const evaluated=await f.actorPost(`${base}/${draft.id}/evaluate`,{instant:'2026-10-27T18:00:00Z',groups:{sales:{members:[{id:q.spanish,eligible:true}]}}})
  assert.equal(evaluated.status,200);assert.deepEqual((await evaluated.json()).group.selected,[q.spanish])
  assert.equal((await f.actorPost(`${base}/${draft.id}/publish`,{revision:0,confirm:'approve this exact tested flow version'})).status,403)
  await f.ownerPost(`${base}/${draft.id}/publish`,{revision:0,confirm:'approve this exact tested flow version'})
  const next=await f.ownerPost(base,{flowId:allowed.flowId,previousVersionId:draft.id,definition:f.definition},201)
  assert.equal((await f.actorPost(`${base}/${next.id}/publish`,{revision:1,confirm:'approve this exact tested flow version'})).status,403)
  assert.equal((await f.ownerPost(base,{flowId:allowed.flowId,previousVersionId:next.id,definition:f.definition},201)).version,4)
  await runtime.restart();catalog=await (await read()).json()
  assert.deepEqual(catalog.publications.map(p=>[p.version_id,p.revision,p.approved_by]),[[draft.id,1,q.english]])
  assert.deepEqual(catalog.tests.map(t=>t.version_id),[draft.id]);assert.ok(catalog.versions.every(v=>v.flow_id===allowed.flowId))
  const audit=(await runtime.sql("SELECT action,policy FROM hnd_audit WHERE subject=? AND action IN ('flow.draft','flow.test')",draft.id)).results
  assert.deepEqual(audit.map(r=>r.action).sort(),['flow.draft','flow.test'])
  assert.ok(audit.every(r=>JSON.parse(r.policy).applied.access.id===role.id))
  assert.equal((await post(runtime,'/auth/operator/status',{operatorId:f.personId,status:'inactive'},q.headers)).status,200)
  assert.equal((await read()).status,401)
  assert.equal((await f.actorPost(`${base}/${draft.id}/evaluate`,{instant:'2026-10-27T18:00:00Z'})).status,401)
  assert.equal((await post(runtime,'/auth/operator/status',{operatorId:f.personId,status:'active'},q.headers)).status,200)
  const renewed=await signIn({...runtime,ownerEmail:f.personId+'@example.test'})
  assert.equal((await runtime.request(base,{headers:{cookie:renewed.cookie}})).status,403,'reactivation never restores withdrawn assignment')
  f.person.version=(await runtime.sql('SELECT version FROM oa_operators WHERE id=?',f.personId)).results[0].version
  await f.assign(role)
  assert.equal((await runtime.request(base,{headers:{cookie:renewed.cookie}})).status,200)
  await runtime.sql('UPDATE oa_operators SET version=version+1 WHERE id=?',q.english)
  assert.equal((await runtime.request(base,{headers:{cookie:renewed.cookie}})).status,403,'issuing owner version loss suspends the role')
 }finally{await runtime.close()}
})
