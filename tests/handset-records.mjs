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
