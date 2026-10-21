import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'
import { adminCsv, adminFixture } from './helpers/handset-admin.mjs'

test('Bulk admin validates 60 users and 40 devices, binds exact cost approval and resumes interrupted native apply without invitations or charges',async()=>{
 const runtime=await openHandset()
 try{
  const f=await adminFixture(runtime),mailCount=runtime.mails.length
  const invalid=await f.preview(adminCsv({broken:true}))
  assert.ok(invalid.snapshot.errors.some(e=>e.file==='user'&&e.row===3&&e.field==='extension'))
  assert.ok(invalid.snapshot.errors.some(e=>e.file==='device'&&e.row===3&&e.field==='mac'))
  assert.ok(invalid.snapshot.errors.some(e=>e.file==='device'&&e.row===4&&e.field==='emergencyAddress'))
  assert.equal((await f.send('/plans/'+invalid.id+'/approve',{planHash:invalid.hash,confirm:'approve exact local configuration'})).status,409)
  const preview=await f.preview()
  assert.equal(preview.snapshot.errors.length,0)
  assert.equal(preview.snapshot.rows.length,100)
  assert.ok(preview.snapshot.rows.every(row=>row.requiredApproval.length&&row.localCostCents===0))
  assert.equal(preview.snapshot.cost.chargesAuthorized,false)
  assert.equal(preview.snapshot.cost.providerCost,'unavailable')
  assert.equal((await f.send('/plans/'+preview.id+'/apply',{planHash:preview.hash})).status,409)
  assert.equal((await f.send('/plans/'+preview.id+'/approve',{planHash:invalid.hash,confirm:'approve exact local configuration'})).status,409)
  const approved=await f.approve(preview),partial=await f.apply(approved,11)
  assert.equal(partial.status,'applying');assert.equal(partial.cursor,11)
  const restored=await f.read('/plans/'+partial.id)
  assert.equal(restored.cursor,11,'durable cursor survives interruption between HTTP requests')
  const completed=await f.finish(restored),replay=await f.apply(completed)
  assert.equal(replay.replay,true);assert.equal(replay.cursor,100)
  const state=await f.read('/bulk'),users=state.profiles.filter(p=>p.kind==='user'),devices=state.profiles.filter(p=>p.kind==='device')
  assert.equal(users.length,60);assert.equal(devices.length,40)
  assert.equal(new Set(state.profiles.map(p=>p.extension)).size,100)
  const nativeUsers=(await runtime.sql('SELECT o.* FROM oa_operators o JOIN hnd_admin_profiles p ON p.operator_id=o.id')).results
  assert.equal(nativeUsers.length,60);assert.ok(nativeUsers.every(o=>o.status==='invited'&&o.role==='member'),'pending native accounts have no activation or invitation token')
  const endpoints=(await runtime.sql("SELECT r.* FROM hnd_records r JOIN hnd_admin_profiles p ON p.record_id=r.id WHERE p.kind='device'")).results
  assert.equal(endpoints.length,40);assert.ok(endpoints.every(r=>r.kind==='endpoint'&&r.source==='native'))
  assert.equal((await runtime.sql('SELECT count(*) AS n FROM hnd_admin_applied_rows WHERE plan_id=?',completed.id)).results[0].n,100)
  assert.equal((await runtime.sql("SELECT count(*) AS n FROM oa_tokens WHERE kind='invite'")).results[0].n,0)
  assert.equal((await runtime.sql("SELECT count(*) AS n FROM hnd_records WHERE kind IN ('usage','provider_attempt')")).results[0].n,0)
  assert.equal(runtime.mails.length,mailCount)
  const identical=await f.preview(),updated=await f.finish(await f.approve(identical))
  assert.equal(updated.status,'completed')
  assert.equal((await f.read('/bulk')).profiles.length,100,'natural identities update native records rather than duplicate them')
  const audit=await (await runtime.request('/api/handset/audit/export',{headers:f.headers})).json()
  assert.ok(audit.rows.some(row=>row.action==='admin.approve'&&row.subject===completed.id))
  assert.ok(audit.rows.some(row=>row.action==='admin.apply'&&row.subject===completed.id))
  assert.ok(!JSON.stringify(audit.rows).includes('synthetic-handset-1000@example.test'))
 }finally{await runtime.close()}
})

test('Scoped versioned templates show selected diffs, reject stale authority, preserve independent overrides and leave consent and call evidence intact',async()=>{
 const runtime=await openHandset()
 try{
  const f=await adminFixture(runtime,{users:3,devices:1})
  await f.finish(await f.approve(await f.preview()))
  const all=(await f.read('/bulk')).profiles,users=all.filter(p=>p.kind==='user'),selected=users[0],other=users[1],greeting=users.find(p=>JSON.parse(p.config).role==='greeting')
  const record=async(kind,data,parentId)=>{
   const response=await post(runtime,'/api/handset/records',{kind,data,parentId,sourceId:crypto.randomUUID(),occurredAt:Date.now()},f.headers)
   assert.equal(response.status,201,await response.clone().text());return (await response.json()).record
  }
  const consent=await record('consent',{purpose:'One consented callback',state:'held'},selected.record_id)
  const call=await record('call_session',{direction:'inbound',state:'uncertain'},selected.record_id)
  const flow=await record('flow_version',{name:'Current locally recorded flow',revision:'1'},selected.record_id)
  const original=(await runtime.sql('SELECT * FROM hnd_records WHERE id IN (?,?,?) ORDER BY id',consent.id,call.id,flow.id)).results
  const overridden=await f.result(await f.send('/profiles/'+selected.id+'/override',{version:selected.version,settings:{greeting:'Rosa’s independent greeting'}}))
  let template=await f.create('/templates',{name:'Austin reception',kind:'user',roleScope:['member'],settings:{hours:'Monday–Friday 09:00–17:00 America/Chicago',greeting:'Welcome / Bienvenidos',ringRules:'Sequential, 20 seconds'}})
  assert.equal((await f.send('/templates',{name:'Role bypass',kind:'user',roleScope:['member'],settings:{role:'admin'}})).status,400)
  assert.equal((await f.send('/templates',{name:'Billing bypass',kind:'user',roleScope:['admin'],settings:{greeting:'Hello'}})).status,400)
  const forbidden=await f.create('/templates/'+template.id+'/preview',{version:template.version,profileIds:[greeting.id]})
  assert.ok(forbidden.snapshot.errors.some(e=>e.code==='template_scope_refused'))
  assert.equal((await f.send('/plans/'+forbidden.id+'/approve',{planHash:forbidden.hash,confirm:'approve exact local configuration'})).status,409)
  const stale=await f.create('/templates/'+template.id+'/preview',{version:template.version,profileIds:[selected.id]})
  assert.ok(stale.snapshot.rows[0].changes.some(c=>c.field==='hours'))
  assert.ok(!stale.snapshot.rows[0].changes.some(c=>c.field==='greeting'),'independent override wins in preview')
  await f.approve(stale)
  template=await f.result(await f.send('/templates/'+template.id,{version:template.version,name:template.name,kind:'user',roleScope:['member'],settings:{hours:'Monday–Friday 10:00–17:00 America/Chicago',greeting:'Revised welcome',ringRules:'Sequential, 15 seconds'}}))
  assert.equal((await f.send('/plans/'+stale.id+'/apply',{planHash:stale.hash})).status,409)
  assert.equal((await f.send('/templates/'+template.id+'/preview',{version:1,profileIds:[selected.id]})).status,409)
  const plan=await f.create('/templates/'+template.id+'/preview',{version:template.version,profileIds:[selected.id]})
  await f.finish(await f.approve(plan))
  const changed=await f.read('/profiles/'+selected.id),unchanged=await f.read('/profiles/'+other.id)
  assert.equal(JSON.parse(changed.config).greeting,'Rosa’s independent greeting')
  assert.equal(JSON.parse(changed.overrides).greeting,JSON.parse(overridden.overrides).greeting)
  assert.equal(JSON.parse(changed.config).hours,JSON.parse(template.settings).hours)
  assert.equal(changed.template_version,template.version)
  assert.equal(unchanged.config,other.config);assert.equal(unchanged.version,other.version)
  assert.deepEqual((await runtime.sql('SELECT * FROM hnd_records WHERE id IN (?,?,?) ORDER BY id',consent.id,call.id,flow.id)).results,original)
  const history=(await f.read('/templates/'+template.id)).history
  assert.equal(history.length,2)
  assert.notEqual(history[0].snapshot,history[1].snapshot)
  const another=await f.create('/templates/'+template.id+'/preview',{version:template.version,profileIds:[selected.id]})
  await f.approve(another)
  await f.result(await f.send('/profiles/'+selected.id+'/override',{version:changed.version,settings:{hours:'Independent hours'}}))
  assert.equal((await f.send('/plans/'+another.id+'/apply',{planHash:another.hash})).status,409,'record changes invalidate the reviewed snapshot')
 }finally{await runtime.close()}
})

test('Bulk and template public doors require current native administrative authority, with mutation origins and role elevation refused',async()=>{
 const runtime=await openHandset()
 try{
  assert.equal((await runtime.request('/api/handset/admin/bulk')).status,401)
  assert.equal((await post(runtime,'/api/handset/admin/bulk/preview',adminCsv())).status,401)
  const f=await adminFixture(runtime,{users:2,devices:1})
  assert.equal((await post(runtime,'/api/handset/admin/bulk/preview',{usersCsv:f.csv.usersCsv},{cookie:f.cookie,origin:'https://example.test'})).status,403)
  const invalid=adminCsv({users:2,devices:1})
  invalid.usersCsv=invalid.usersCsv.replace('"member"','"admin"')
  const elevated=await f.preview(invalid)
  assert.ok(elevated.snapshot.errors.some(e=>e.code==='role_grant_requires_separate_authority'))
  assert.equal((await f.send('/plans/'+elevated.id+'/approve',{planHash:elevated.hash,confirm:'approve exact local configuration'})).status,409)
  for(const role of ['member']){
   await runtime.sql('UPDATE oa_operators SET role=?,status=? WHERE id=?',role,'active','synthetic-handset-2')
   const actor=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'}),headers={cookie:actor.cookie}
   for(const path of ['/api/handset/admin/bulk','/app/admin/bulk','/app/admin/templates'])assert.equal((await runtime.request(path,{headers})).status,403)
   assert.equal((await post(runtime,'/api/handset/admin/templates',{name:'Self promotion',kind:'user',roleScope:['member'],settings:{greeting:'Hello'}},headers)).status,403)
  }
  const preview=await f.preview()
  await runtime.sql('UPDATE oa_operators SET version=version+1 WHERE id=?','synthetic-handset-1')
  assert.equal((await f.send('/plans/'+preview.id+'/approve',{planHash:preview.hash,confirm:'approve exact local configuration'})).status,401)
 }finally{await runtime.close()}
})

test('Native admins can apply member configuration but cannot change owner or admin records, promote roles or retain revoked approval authority',async()=>{
 const runtime=await openHandset()
 try{
  const owner=await adminFixture(runtime,{users:2,devices:1})
  await runtime.sql("UPDATE oa_operators SET role='admin',status='active' WHERE id=?",'synthetic-handset-2')
  const login=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  const admin=await adminFixture(runtime,{users:2,devices:1,cookie:login.cookie})
  await admin.finish(await admin.approve(await admin.preview()))
  assert.equal((await admin.read('/bulk')).profiles.length,3)
  assert.equal((await runtime.request('/app/admin/templates',{headers:admin.headers})).status,200)
  const protectedCsv={usersCsv:'email,name,extension,location,emergencyAddress,role\n'+runtime.ownerEmail+',Mara Patel,9000,Austin office,"110 Congress Avenue, Austin TX 78701",member\nsynthetic-handset-2@example.test,Elliot Brooks,9001,Austin office,"110 Congress Avenue, Austin TX 78701",member',devicesCsv:''}
  await owner.finish(await owner.approve(await owner.preview(protectedCsv)))
  const protectedProfiles=(await owner.read('/bulk')).profiles.filter(p=>p.operator_id==='synthetic-handset-1'||p.operator_id==='synthetic-handset-2')
  assert.equal(protectedProfiles.length,2)
  const refused=await admin.preview(protectedCsv)
  assert.ok(refused.snapshot.errors.filter(e=>e.code==='elevated_target_protected').length===2)
  for(const p of protectedProfiles)assert.equal((await admin.send('/profiles/'+p.id+'/override',{version:p.version,settings:{greeting:'Unauthorized owner override'}})).status,403)
  const t=await admin.create('/templates',{name:'Member defaults',kind:'user',roleScope:['member'],settings:{greeting:'Welcome'}})
  const scoped=await admin.create('/templates/'+t.id+'/preview',{version:t.version,profileIds:protectedProfiles.map(p=>p.id)})
  assert.ok(scoped.snapshot.errors.every(e=>e.code==='elevated_target_protected'))
  assert.equal((await admin.send('/plans/'+scoped.id+'/approve',{planHash:scoped.hash,confirm:'approve exact local configuration'})).status,409)
  const future=await admin.preview(adminCsv({users:3,devices:1}))
  const approved=await admin.approve(future)
  assert.equal(approved.approved_role,'admin')
  const demote=await post(runtime,'/auth/operator/role',{operatorId:'synthetic-handset-2',role:'member'},owner.headers)
  assert.equal(demote.status,200,await demote.clone().text())
  assert.equal((await admin.send('/plans/'+future.id+'/apply',{planHash:future.hash})).status,401)
  assert.equal((await owner.send('/plans/'+future.id+'/apply',{planHash:future.hash})).status,409,'another owner cannot reuse a demoted approver’s authority')
  assert.equal((await owner.read('/bulk')).profiles.length,5)
  const native=(await runtime.sql('SELECT role,version FROM oa_operators WHERE id=?','synthetic-handset-1')).results[0]
  assert.equal(native.role,'owner');assert.equal(native.version,1,'administration does not alter owner role or admission version')
 }finally{await runtime.close()}
})
