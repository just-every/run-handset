import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'

export async function recordsFixture(runtime, cookie) {
 const headers={cookie}
 async function create(path,value){const response=await post(runtime,path,value,headers);assert.equal(response.status,201,await response.clone().text());return response.json()}
 const detail=await create('/api/handset/cases',{title:'Austin service callback / Devolución de llamada',promise:'Confirm the replacement appointment',dueAt:Date.now()+86400000})
 const caseId=detail.current.id
 const entries={}
 async function entry(kind,data,parentId,links=[]){
  const result=await create('/api/handset/records',{kind,data,sourceId:`synthetic-handset-${Object.keys(entries).length+20}`,occurredAt:Date.now(),caseId,parentId,links})
  entries[kind]=result.record
  return result.record.id
 }
 const company=await entry('company',{name:'Austin Service Co.'})
 const location=await entry('location',{name:'Congress Avenue',timezone:'America/Chicago'},company,[{targetId:company,relation:'company'}])
 const number=await entry('number',{e164:'+15125550142'},location)
 const person=await entry('person',{name:'Rosa García'},company)
 const endpoint=await entry('endpoint',{name:'Front desk',platform:'web'},person)
 const flow=await entry('flow_version',{name:'Spanish support',revision:'1'},number)
 const session=await entry('call_session',{direction:'inbound',state:'uncertain'},number,[{targetId:person,relation:'person'},{targetId:flow,relation:'flow'}])
 const leg=await entry('call_leg',{state:'uncertain'},session,[{targetId:endpoint,relation:'endpoint'}])
 await entry('call_leg',{state:'uncertain',transferFrom:leg},leg)
 await entry('queue_entry',{state:'pending'},session)
 await entry('callback',{state:'pending',dueAt:Date.now()+86400000},session)
 const conversation=await entry('conversation',{subject:'Replacement appointment'},session)
 await entry('message',{channel:'voicemail',direction:'inbound',state:'unknown',text:'Requested a callback'},conversation)
 await entry('message',{channel:'mms',direction:'outbound',state:'uncertain',text:'Photo delivery is not confirmed'},conversation)
 const media=await entry('media',{name:'Synthetic photo',mime:'image/png',sizeBytes:256},conversation)
 await entry('consent',{purpose:'One callback',state:'held'},person)
 await entry('recording',{name:'Unverified voicemail reference',state:'unknown'},media)
 await entry('transcript',{text:'Synthetic request for a replacement appointment',language:'es'},media)
 await entry('disposition',{text:'Awaiting customer confirmation'},session)
 await entry('promise',{text:'Confirm the appointment',dueAt:Date.now()+86400000},conversation)
 await entry('provider_attempt',{operation:'send',state:'uncertain'},conversation)
 await entry('usage',{amountCents:0,currency:'USD'},session)
 await entry('comment',{text:'Please follow up / Por favor confirma',mention:person},conversation,[{targetId:person,relation:'mentions'}])
 return {detail,caseId,entries,create}
}

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
