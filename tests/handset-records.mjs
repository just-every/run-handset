import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'

import { recordsFixture } from './helpers/handset-records.mjs'

test('Native canonical records link source identities and preserve uncertain case work across conflicting edits',async()=>{
 const runtime=await openHandset()
 try{
  const {cookie}=await signIn(runtime),headers={cookie}
  const {caseId,entries}=await recordsFixture(runtime,cookie)
  let detail=await (await runtime.request('/api/handset/cases/'+caseId,{headers})).json()
  assert.equal(new Set(detail.records.map(r=>r.id)).size,detail.records.length)
  assert.equal(new Set(detail.records.map(r=>r.kind)).size,21)
  for(const r of detail.records){assert.equal(r.source,'native');assert.ok(r.source_id);assert.ok(r.occurred_at<=r.received_at)}
  const leg=await (await runtime.request('/api/handset/records/'+entries.call_leg.id,{headers})).json()
  assert.ok(leg.record.parent_id)
  for(const link of leg.links)assert.equal((await runtime.request('/api/handset/records/'+link.target_id,{headers})).status,200)
  // Independent native owner, not a substituted server session.
  await runtime.sql("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES (?,?,?,?,?,?)",'synthetic-handset-90','synthetic-handset-90@example.test','Second owner','owner','active',Date.now())
  const second=await signIn({...runtime,ownerEmail:'synthetic-handset-90@example.test'})
  const work={title:detail.current.title,promise:detail.current.promise,dueAt:detail.current.due_at,ownerId:'synthetic-handset-90',version:1}
  const responses=await Promise.all([post(runtime,'/api/handset/cases/'+caseId,work,headers),post(runtime,'/api/handset/cases/'+caseId,{...work,title:'Concurrent edit'},{cookie:second.cookie})])
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409])
  const conflict=await responses.find(r=>r.status===409).json()
  assert.equal(conflict.detail.current.version,2)
  detail=await (await runtime.request('/api/handset/cases/'+caseId,{headers})).json()
  assert.equal(detail.history.length,2)
  assert.equal(detail.current.owner_id,'synthetic-handset-90')
  for(const status of ['closed','open']){
   const response=await post(runtime,'/api/handset/cases/'+caseId,{title:detail.current.title,ownerId:detail.current.owner_id,promise:detail.current.promise,dueAt:detail.current.due_at,version:detail.current.version,status,closeReason:status==='closed'?'Human review; delivery remains uncertain':''},headers)
   assert.equal(response.status,200,await response.clone().text());detail=await response.json()
   assert.equal(detail.current.promise,work.promise);assert.equal(detail.current.due_at,work.dueAt)
   assert.equal(JSON.parse(detail.records.find(r=>r.id===entries.message.id).data).state,'uncertain')
  }
  const filtered=await (await runtime.request('/api/handset/cases?q=replacement&status=open&ownerId=synthetic-handset-90',{headers})).json()
  assert.deepEqual(filtered.cases.map(c=>c.id),[caseId])
  assert.equal((await post(runtime,'/api/handset/filters',{name:'Due service callbacks',query:{q:'replacement',status:'open',due:'scheduled'}},headers)).status,201)
 }finally{await runtime.close()}
})

test('Canonical corrections append, exact source replay is idempotent, and direct writes reject fabricated receipt states and foreign links',async()=>{
 const runtime=await openHandset()
 try{
  const {cookie}=await signIn(runtime),headers={cookie}
  const c=await (await post(runtime,'/api/handset/cases',{title:'Native work'},headers)).json()
  const base={kind:'message',sourceId:'synthetic-handset-100',occurredAt:Date.now(),caseId:c.current.id,data:{channel:'mms',direction:'outbound',state:'uncertain'}}
  const first=await (await post(runtime,'/api/handset/records',base,headers)).json()
  const replay=await (await post(runtime,'/api/handset/records',base,headers)).json()
  assert.equal(first.record.id,replay.record.id);assert.equal(replay.replay,true)
  assert.equal((await post(runtime,'/api/handset/records',{...base,data:{...base.data,text:'Changed'}},headers)).status,409)
  const correction=await post(runtime,'/api/handset/records',{...base,sourceId:'synthetic-handset-101',supersedesId:first.record.id,data:{...base.data,text:'Corrected native observation'}},headers)
  assert.equal(correction.status,201)
  const detail=await (await runtime.request('/api/handset/cases/'+c.current.id,{headers})).json()
  assert.equal(detail.records.length,2);assert.deepEqual(JSON.parse(detail.records[0].data),base.data)
  assert.equal((await post(runtime,'/api/handset/records',{...base,sourceId:'synthetic-handset-102',data:{...base.data,state:'delivered'}},headers)).status,400)
  assert.equal((await post(runtime,'/api/handset/records',{...base,sourceId:'synthetic-handset-103',source:'carrier'},headers)).status,400)
  const other=await (await post(runtime,'/api/handset/cases',{title:'Other case'},headers)).json()
  assert.equal((await post(runtime,'/api/handset/records',{...base,caseId:other.current.id,sourceId:'synthetic-handset-104',parentId:first.record.id},headers)).status,400)
  await assert.rejects(runtime.sql('UPDATE hnd_records SET data=? WHERE id=?','{}',first.record.id),/append_only/)
  await assert.rejects(runtime.sql('DELETE FROM hnd_case_history WHERE case_id=?',c.current.id),/append_only/)
  assert.equal((await post(runtime,'/api/handset/cases',{title:'No deadline',promise:'A commitment'},headers)).status,400)
  assert.equal((await post(runtime,'/api/handset/cases',{title:'Missing assignee',ownerId:'synthetic-handset-404'},headers)).status,409)
 }finally{await runtime.close()}
})

test('Audit exports and restored checkpoints retain accountability without planted personal or payload content',async()=>{
 const runtime=await openHandset()
 try{
  const {cookie}=await signIn(runtime),headers={cookie}
  const planted=['Synthetic secret caller name','+15125550197','Private call text synthetic-handset-901','synthetic-handset-902']
  await post(runtime,'/api/handset/cases',{title:planted.join(' ')},headers)
  await post(runtime,'/api/handset/records',{kind:'provider_attempt',sourceId:'synthetic-handset-903',occurredAt:Date.now(),data:{operation:planted.join(' '),state:'uncertain'}},headers)
  assert.equal((await post(runtime,'/api/handset/audit/modify',{actor:planted[0],outcome:'completed'},headers)).status,403)
  const exported=await runtime.request('/api/handset/audit/export',{headers})
  assert.equal(exported.status,200)
  const archive=await exported.json(),encoded=JSON.stringify(archive)
  for(const secret of [...planted,runtime.ownerEmail])assert.ok(!encoded.includes(secret),secret)
  assert.ok(archive.rows.some(r=>r.action==='auth.signin'))
  assert.ok(archive.rows.some(r=>r.outcome==='uncertain'&&archive.rows.some(receipt=>receipt.subject===r.subject&&receipt.action===r.action&&receipt.outcome==='completed'&&receipt.sequence>r.sequence)),'native auth retains a durable uncertain attempt before the terminal response receipt')
  assert.ok(archive.rows.some(r=>r.action==='audit.modify' && r.outcome==='refused'))
  assert.ok(archive.rows.every(r=>r.actor && r.occurred_at && r.policy && r.subject && r.outcome))
  const restore={archive,expectedCheckpoint:archive.checkpoint,confirm:'restore evidence only'}
  assert.equal((await post(runtime,'/api/handset/audit/restore',restore,headers)).status,201)
  const restored=await (await runtime.request('/api/handset/audit/archive/'+archive.checkpoint,{headers})).json()
  assert.deepEqual(restored.rows,archive.rows)
  const changed=structuredClone(restore);changed.archive.rows[0].outcome='failed'
  assert.equal((await post(runtime,'/api/handset/audit/restore',changed,headers)).status,400)
  assert.equal((await post(runtime,'/api/handset/audit/restore',{...restore,expectedCheckpoint:'0'.repeat(64)},headers)).status,400)
  await assert.rejects(runtime.sql("UPDATE hnd_audit SET outcome='completed' WHERE sequence=1"),/append_only/)
  await assert.rejects(runtime.sql('DELETE FROM hnd_audit WHERE sequence=1'),/append_only/)
  // The independent archived receipt still proves the same opaque actor after
  // native deactivation and removal of their attribution mapping.
  await runtime.sql("UPDATE oa_operators SET status='active' WHERE id='synthetic-handset-2'")
  const member=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  assert.equal((await runtime.request('/api/handset/cases',{headers:{cookie:member.cookie}})).status,403)
  const mapping=(await runtime.sql('SELECT pseudonym FROM hnd_actor_refs WHERE operator_id=?','synthetic-handset-2')).results[0].pseudonym
  await runtime.sql("UPDATE oa_operators SET status='inactive' WHERE id='synthetic-handset-2'")
  const before=(await runtime.sql('SELECT * FROM hnd_audit WHERE actor=? ORDER BY sequence',mapping)).results
  assert.ok(before.length)
  assert.equal((await post(runtime,'/api/handset/audit/anonymize',{operatorId:'synthetic-handset-2',confirm:'anonymize audit identity'},headers)).status,200)
  assert.deepEqual((await runtime.sql('SELECT * FROM hnd_audit WHERE actor=? ORDER BY sequence',mapping)).results,before)
  assert.equal((await runtime.sql('SELECT * FROM hnd_actor_refs WHERE operator_id=?','synthetic-handset-2')).results.length,0)
  for(const path of ['/api/handset/audit','/api/handset/audit/export'])assert.equal((await runtime.request(path,{headers:{cookie:member.cookie}})).status,401)
  assert.equal((await post(runtime,'/api/handset/audit/anonymize',{operatorId:'synthetic-handset-1',confirm:'anonymize audit identity'},headers)).status,409)
 }finally{await runtime.close()}
})

test('Signed carrier events correlate transfers recording and MMS with immutable provider time and replay receipts',async()=>{
 const {sourceFixture}=await import('./helpers/handset-sources.mjs')
 const runtime=await openHandset({twilio:true})
 try{
  const f=await sourceFixture(runtime),timestamp=new Date(Date.now()-60000).toUTCString()
  const root={CallSid:'synthetic-handset-510',CallStatus:'in-progress',SequenceNumber:'0',Timestamp:timestamp}
  const child={CallSid:'synthetic-handset-511',ParentCallSid:root.CallSid,CallStatus:'in-progress',SequenceNumber:'0',Timestamp:timestamp}
  assert.equal((await f.callback(child)).status,202,'child is held until its verified parent exists')
  const first=await f.callback(root)
  assert.equal(first.status,200,await first.clone().text())
  const receipt=await first.json(),caseId=receipt.caseId
  assert.equal((await runtime.sql('SELECT * FROM hnd_source_pending')).results.length,0)
  const recording={CallSid:root.CallSid,RecordingSid:'synthetic-handset-512',RecordingStatus:'completed',From:'',To:''}
  f.resource('Recordings',recording.RecordingSid,{call_sid:root.CallSid,start_time:timestamp,date_created:timestamp})
  assert.equal((await f.callback(recording)).status,200)
  const message={MessageSid:'synthetic-handset-513',MessageStatus:'received',Body:' Synthetic appointment photo ',NumMedia:'1',MediaUrl0:'https://api.twilio.com/2010-04-01/Accounts/synthetic-handset-502/Messages/synthetic-handset-513/Media/synthetic-handset-514',MediaContentType0:'image/png'}
  f.resource('Messages',message.MessageSid,{from:'+15125550126',to:'+15125550125',date_sent:timestamp,date_created:timestamp})
  assert.equal((await f.callback(message)).status,200)
  const duplicate=await f.callback(message);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).replay,true)
  assert.equal((await f.callback({...message,Body:'Changed receipt content'})).status,409)
  const detail=await (await runtime.request('/api/handset/cases/'+caseId,{headers:f.headers})).json()
  assert.equal(detail.records.length,5)
  assert.ok(detail.records.every(r=>r.source==='twilio'&&r.occurred_at===Date.parse(timestamp)&&r.received_at>=r.occurred_at))
  const leg=detail.records.find(r=>r.kind==='call_leg'),call=detail.records.find(r=>r.kind==='call_session')
  assert.equal(leg.parent_id,call.id)
  const mms=detail.records.find(r=>r.kind==='message'),media=JSON.parse(mms.data)
  assert.equal(detail.records.find(r=>r.kind==='media').parent_id,mms.id)
  assert.equal(media.text,message.Body);assert.equal(media.channel,'mms');assert.equal(media.providerStatus,'received');assert.equal(media.customerOutcome,'unconfirmed')
  assert.equal((await runtime.sql('SELECT count(*) AS count FROM hnd_cases')).results[0].count,1,'one shared caller case across sources')
  assert.ok(runtime.sourceRequests.every(r=>r.method==='GET'&&!r.url.includes('/Media/')),'source readback never downloads audio or images')
  assert.equal((await post(runtime,'/api/handset/cases/'+caseId,{title:detail.current.title,version:1,promise:'Return the requested callback',dueAt:Date.now()+86400000},f.headers)).status,200)
  // A later completed call leg is a transport fact, not a closed customer case.
  assert.equal((await f.callback({...root,CallStatus:'completed',SequenceNumber:'1',CallDuration:'75'})).status,200)
  const later=await (await runtime.request('/api/handset/cases/'+caseId,{headers:f.headers})).json()
  assert.equal(later.records.filter(r=>r.kind==='call_session').length,1,'provider status changes retain one canonical call')
  const status= later.records.find(r=>r.kind==='provider_attempt')
  assert.equal(status.parent_id,call.id);assert.equal(JSON.parse(status.data).providerStatus,'completed')
  const linked=await(await runtime.request('/api/handset/records/'+call.id,{headers:f.headers})).json()
  assert.ok(linked.related.some(r=>r.id===status.id))
  assert.equal(later.current.status,'open');assert.ok(later.current.promise);assert.equal(later.current.version,2)
  const exported=await (await runtime.request('/api/handset/audit/export',{headers:f.headers})).json()
  const audit=JSON.stringify(exported)
  assert.ok(exported.rows.some(r=>r.actor===f.source.id&&r.action==='source.receive'))
  assert.ok(!audit.includes(message.Body)&&!audit.includes('+15125550126')&&!audit.includes('synthetic-handset-500'))
 }finally{await runtime.close()}
})

test('Unsigned foreign-number revoked and failed-readback carrier events cannot forge canonical communication facts',async()=>{
 const {sourceFixture}=await import('./helpers/handset-sources.mjs')
 const runtime=await openHandset({twilio:true})
 try{
  const f=await sourceFixture(runtime),root={CallSid:'synthetic-handset-520',CallStatus:'ringing',SequenceNumber:'0',Timestamp:new Date().toUTCString()}
  assert.equal((await f.callback(root,{signature:false})).status,403)
  assert.equal((await f.callback(root,{origin:'https://foreign.example'})).status,403)
  assert.equal((await f.callback({...root,AccountSid:'synthetic-handset-foreign'})).status,403)
  assert.equal((await f.callback({...root,From:'+15125550128',To:'+15125550129'})).status,403)
  assert.equal((await f.callback({MessageSid:'synthetic-handset-521',MessageStatus:'received',Body:'Readback is missing',NumMedia:'0'})).status,503)
  assert.equal((await runtime.sql('SELECT count(*) AS count FROM hnd_source_receipts')).results[0].count,0)
  assert.equal((await f.callback(root)).status,200)
  assert.equal((await post(runtime,'/api/handset/sources/revoke',{sourceId:f.source.id},f.headers)).status,200)
  assert.equal((await f.callback({...root,SequenceNumber:'1',CallStatus:'completed'})).status,403)
  assert.equal((await runtime.sql('SELECT count(*) AS count FROM hnd_source_receipts')).results[0].count,1)
 }finally{await runtime.close()}
})

test('Exact-person supervisor playback is audited, denies inherited delegation and fails closed on revoke during provider readback',async()=>{
 const {delegationFixture,recordingFixture}=await import('./helpers/handset-delegation.mjs')
 const runtime=await openHandset({twilio:true})
 try{
  const f=await delegationFixture(runtime),media=await recordingFixture(runtime,f),path='/api/handset/recordings/'+media.recordingId+'/playback'
  assert.equal((await runtime.request(path,{headers:f.assistantHeaders})).status,403)
  assert.equal((await runtime.request(path,{headers:f.headers})).status,403,'owner still needs exact-person consent')
  assert.equal((await post(runtime,'/api/handset/recordings/grants',media.grantInput,f.assistantHeaders)).status,403)
  const grant=await f.create('recordings/grants',media.grantInput)
  const played=await runtime.request(path,{headers:f.assistantHeaders})
  assert.equal(played.status,200,await played.clone().text());assert.equal(played.headers.get('cache-control'),'private, no-store')
  assert.deepEqual(Buffer.from(await played.arrayBuffer()),media.bytes)
  assert.equal((await runtime.request(path+'?token=synthetic-handset-711',{headers:f.assistantHeaders})).status,400)
  const original=runtime.twilioResources.get(media.meta)
  runtime.twilioResources.set(media.meta,async()=>{
   await runtime.sql('UPDATE hnd_recording_grants SET revoked_at=? WHERE id=?',Date.now(),grant.id)
   return original
  })
  const requests=runtime.sourceRequests.length
  assert.equal((await runtime.request(path,{headers:f.assistantHeaders})).status,503)
  assert.equal(runtime.sourceRequests.length,requests+1,'revocation after metadata prevents the media fetch')
  runtime.twilioResources.set(media.meta,original)
  const second=await f.create('recordings/grants',media.grantInput)
  runtime.twilioResources.set(media.url,async()=>{
   await runtime.sql('UPDATE hnd_recording_grants SET revoked_at=? WHERE id=?',Date.now(),second.id)
   return {__audio:[...media.bytes]}
  })
  assert.equal((await runtime.request(path,{headers:f.assistantHeaders})).status,503,'revocation while receiving media prevents byte release')
  runtime.twilioResources.set(media.url,{__audio:[...media.bytes]})
  const third=await f.create('recordings/grants',media.grantInput)
  runtime.twilioResources.set(media.meta,{...original,call_sid:'synthetic-handset-foreign'})
  assert.equal((await runtime.request(path,{headers:f.assistantHeaders})).status,502)
  runtime.twilioResources.set(media.meta,original)
  assert.equal((await post(runtime,'/api/handset/recordings/grants/'+third.id+'/revoke',{},f.headers)).status,200)
  assert.equal((await runtime.request(path,{headers:f.assistantHeaders})).status,403)
  const archive=await (await runtime.request('/api/handset/audit/export',{headers:f.headers})).json(),actor=(await runtime.sql('SELECT pseudonym FROM hnd_actor_refs WHERE operator_id=?','synthetic-handset-2')).results[0].pseudonym
  assert.ok(archive.rows.some(r=>r.actor===actor&&r.action==='recording.playback'&&r.subject===media.recordingId&&r.outcome==='completed'))
  assert.ok(archive.rows.some(r=>r.actor===actor&&r.action==='recording.playback'&&r.outcome==='refused'))
  assert.ok(archive.rows.some(r=>r.actor===actor&&r.action==='recording.playback'&&r.outcome==='failed'))
 }finally{await runtime.close()}
})

test('Every current native action family retains opaque request outcomes and principal hashes survive evidence restore and actor anonymization',async()=>{
 const {delegationFixture}=await import('./helpers/handset-delegation.mjs')
 const {authorityFixture}=await import('./helpers/handset-authority.mjs')
 const runtime=await openHandset({twilio:true})
 try{
  const f=await delegationFixture(runtime),planted=['Synthetic private actor name','+15125550198','Synthetic secret call text','synthetic-handset-720']
  await post(runtime,'/api/handset/front-desk/operations',f.operation,f.assistantHeaders)
  const families={records:'/api/handset/cases',authority:'/api/handset/grants',audit:'/api/handset/audit',source:'/api/handset/sources',admin:'/api/handset/admin/bulk',queue:'/api/handset/queues',metrics:'/api/handset/metrics',protection:'/api/handset/protection',dialer:'/api/handset/dialer',import:'/app/import',frontdesk:'/api/handset/front-desk',recording:'/app/recordings'}
  for(const path of Object.values(families)){
   await runtime.request(path,{headers:f.headers})
   await post(runtime,path,{unknown:planted.join(' ')},f.headers)
  }
  const application=await authorityFixture(runtime),g=await application.issue()
  assert.equal((await application.app(g.token,'prepare',{state:application.proposed,idempotencyKey:'synthetic-handset-721',callerInstructions:planted.join(' ')})).status,403)
  for(const role of ['admin','member']){
   await runtime.sql('UPDATE oa_operators SET role=? WHERE id=?',role,'synthetic-handset-2')
   const actor=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
   for(const method of ['POST','PUT','DELETE']){
    const response=await runtime.request('/api/handset/audit/modify',{method,headers:{cookie:actor.cookie,origin:runtime.origin,'content-type':'application/json'},body:JSON.stringify({payload:planted.join(' ')})})
    assert.equal(response.status,403)
   }
  }
  const archive=await (await runtime.request('/api/handset/audit/export',{headers:f.headers})).json()
  for(const family of Object.keys(families)){
   const attempts=archive.rows.filter(r=>r.action===family+'.request'&&r.outcome==='uncertain')
   assert.ok(attempts.length,family)
   assert.ok(attempts.some(a=>archive.rows.some(r=>r.action===a.action&&r.subject===a.subject&&r.sequence>a.sequence&&['completed','refused','failed'].includes(r.outcome))),family+' correlated response')
  }
  assert.ok(archive.rows.some(r=>r.actor===g.grant.id&&r.action==='application.attempt'&&r.outcome==='refused'))
  for(const value of [...planted,g.token,runtime.ownerEmail,'Elliot Brooks','Elena Rivera'])assert.ok(!JSON.stringify(archive).includes(value),value)
  const onBehalf=archive.rows.find(r=>r.action==='frontdesk.pickup'&&r.principal)
  assert.ok(onBehalf&&onBehalf.actor!==onBehalf.principal)
  const restore={archive,expectedCheckpoint:archive.checkpoint,confirm:'restore evidence only'}
  assert.equal((await post(runtime,'/api/handset/audit/restore',restore,f.headers)).status,201)
  const changed=structuredClone(restore);changed.archive.rows.find(r=>r.principal).principal=crypto.randomUUID()
  assert.equal((await post(runtime,'/api/handset/audit/restore',changed,f.headers)).status,400)
  await runtime.sql("UPDATE oa_operators SET status='inactive' WHERE id='synthetic-handset-2'")
  assert.equal((await post(runtime,'/api/handset/audit/anonymize',{operatorId:'synthetic-handset-2',confirm:'anonymize audit identity'},f.headers)).status,200)
  const restored=await (await runtime.request('/api/handset/audit/archive/'+archive.checkpoint,{headers:f.headers})).json()
  assert.deepEqual(restored.rows,archive.rows)
  assert.equal((await runtime.sql('SELECT count(*) AS n FROM hnd_actor_refs WHERE operator_id=?','synthetic-handset-2')).results[0].n,0)
  await assert.rejects(runtime.sql("UPDATE hnd_audit SET principal=? WHERE id=?",crypto.randomUUID(),onBehalf.id),/append_only/)
 }finally{await runtime.close()}
})
