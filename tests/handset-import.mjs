import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'
import { importCall, importResult, uploadDataset, planDataset, finishImport, importDataset, nativeDatasets, minimalDataset } from './helpers/handset-import.mjs'

const headers=cookie=>({cookie,'x-import-source':'queue-dataset'})

test('Shared import door enforces native owner sessions and origin while Business stays closed without trust',async()=>{
 const runtime=await openHandset()
 try {
  assert.equal((await importCall(runtime,'','plan',{uploadId:'synthetic-handset-600'})).status,401)
  assert.equal((await runtime.request('/app/import')).status,303)
  const {cookie}=await signIn(runtime)
  assert.equal((await importCall(runtime,cookie,'plan',{}, {origin:'https://foreign.example.test'})).status,403)
  assert.equal((await importCall(runtime,cookie,'plan',{}, {'sec-fetch-site':'cross-site'})).status,403)
  assert.equal((await importCall(runtime,cookie,'plan',{}, {'x-import-source':'unlisted'})).status,400)
  for (const action of ['uploads','plan','apply','status','reconcile','undo']) {
   assert.equal((await post(runtime,'/api/rer/import/'+action,{}, {cookie,authorization:'Bearer synthetic-handset-601'})).status,404)
  }
  const off=await post(runtime,'/api/operator/import/settings',{enabled:true,confirm:'approve Business import settings'},headers(cookie))
  assert.equal(off.status,409)
  assert.equal((await off.json()).error,'business_import_trust_unavailable')
  const screen=await runtime.request('/app/import',{headers:{cookie}})
  assert.equal(screen.status,200)
  assert.match(await screen.text(),/Source JSON/)
  await runtime.sql('UPDATE oa_operators SET status=?,role=? WHERE id=?','active','admin','synthetic-handset-2')
  const other=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  assert.equal((await importCall(runtime,other.cookie,'plan',{})).status,403)
  assert.equal((await runtime.request('/app/import',{headers:{cookie:other.cookie}})).status,403)
  assert.deepEqual(await nativeDatasets(runtime,cookie),[])
 } finally { await runtime.close() }
})

test('Reviewed native imports plan without writes, reject changed fingerprints, resume across sign-out, reconcile and Undo from shared history',async()=>{
 const runtime=await openHandset()
 try {
  let {cookie}=await signIn(runtime)
  const source=Array.from({length:25},(_,n)=>minimalDataset(620+n*10))
  const before=await nativeDatasets(runtime,cookie),mailCount=runtime.mails.length
  const uploadId=await uploadDataset(runtime,cookie,source)
  const inventory=await importResult(runtime,cookie,'uploads',{uploadId})
  assert.equal(inventory.complete,true)
  assert.ok(inventory.received.length>0)
  const plan=await importResult(runtime,cookie,'plan',{uploadId})
  assert.equal(plan.summary.sourceRecords,25)
  assert.equal(plan.summary.created,25)
  assert.deepEqual(await nativeDatasets(runtime,cookie),before)
  const wrong=(plan.fingerprint[0]==='0'?'1':'0')+plan.fingerprint.slice(1)
  await importResult(runtime,cookie,'apply',{planId:plan.planId,reviewedFingerprint:wrong},403)
  assert.deepEqual(await nativeDatasets(runtime,cookie),before)
  const partial=await importResult(runtime,cookie,'apply',{planId:plan.planId,reviewedFingerprint:plan.fingerprint})
  assert.ok(['queued','applying'].includes(partial.job.state))
  assert.equal((await post(runtime,'/auth/signout',{}, {cookie})).status,204)
  assert.equal((await importCall(runtime,cookie,'apply',{planId:plan.planId,reviewedFingerprint:plan.fingerprint})).status,401)
  ;({cookie}=await signIn(runtime))
  const applied=await finishImport(runtime,cookie,'apply',plan)
  const replay=await importResult(runtime,cookie,'apply',{planId:plan.planId,reviewedFingerprint:plan.fingerprint})
  assert.equal(replay.job.id,applied.job.id)
  const status=await importResult(runtime,cookie,'status',{planId:plan.planId})
  assert.equal(status.job.state,'completed')
  const report=await importResult(runtime,cookie,'reconcile',{planId:plan.planId})
  assert.equal(report.ok,true)
  assert.equal(report.counts.sourceRecords,25)
  assert.equal(report.counts.present+report.counts.explained,25)
  assert.equal(report.sourceIds.length,25)
  const native=await nativeDatasets(runtime,cookie)
  assert.equal(native.length,25)
  assert.deepEqual(native.map(row=>row.dataset).sort((a,b)=>a.id.localeCompare(b.id)),source.sort((a,b)=>a.id.localeCompare(b.id)))
  const history=await (await runtime.request('/api/operator/import/history',{headers:headers(cookie)})).json()
  assert.ok(history.history.some(h=>h.planId===plan.planId&&h.state==='completed'))
  const screen=await runtime.request('/app/import',{headers:{cookie}})
  assert.match(await screen.text(),/Undo from this history/)
  await finishImport(runtime,cookie,'undo',plan)
  assert.deepEqual(await nativeDatasets(runtime,cookie),before)
  assert.equal(runtime.mails.length,mailCount+1,'only the explicit second sign-in sends mail')
 } finally { await runtime.close() }
})

test('Catch-up upserts historical datasets, explains source removals, keeps correlation and restores its predecessor on Undo',async()=>{
 const runtime=await openHandset()
 try {
  const {cookie}=await signIn(runtime),base=minimalDataset(900),gone=minimalDataset(910)
  base.entries.push({...base.entries[0],id:'synthetic-handset-920',queueId:'synthetic-handset-921',kind:'transfer',parentEntryId:base.entries[0].id,enteredAt:base.entries[0].closedAt,answeredAt:base.entries[0].closedAt+5000,closedAt:base.entries[0].closedAt+65000})
  base.entries.push({...base.entries[1],id:'synthetic-handset-922',kind:'callback',parentEntryId:base.entries[1].id,enteredAt:base.entries[1].closedAt,answeredAt:base.entries[1].closedAt+5000,closedAt:base.entries[1].closedAt+65000})
  const first=await importDataset(runtime,cookie,[base,gone])
  const changed={...base,name:'Corrected historical observation name'}
  const plan=await planDataset(runtime,cookie,[changed],true)
  assert.equal(plan.summary.updated,1)
  assert.equal(plan.summary.gone,1)
  await finishImport(runtime,cookie,'apply',plan)
  const native=await nativeDatasets(runtime,cookie)
  assert.equal(native.length,2,'absent sources never implicitly destroy native data')
  assert.equal(native.find(row=>row.id===base.id).dataset.name,changed.name)
  assert.equal(native.find(row=>row.id===base.id).dataset.entries[2].parentEntryId,base.entries[1].id)
  const report=await importResult(runtime,cookie,'reconcile',{planId:plan.planId})
  assert.equal(report.ok,true)
  assert.equal(report.counts.present+report.counts.explained,report.counts.sourceRecords)
  assert.equal((await importCall(runtime,cookie,'undo',{planId:first.plan.planId})).status,409,'newest layer must be undone first')
  await finishImport(runtime,cookie,'undo',plan)
  assert.deepEqual((await nativeDatasets(runtime,cookie)).find(row=>row.id===base.id).dataset,base)
  await finishImport(runtime,cookie,'undo',first.plan)
  assert.deepEqual(await nativeDatasets(runtime,cookie),[])
 } finally { await runtime.close() }
})

test('Malformed exports and invalid call correlation are named refusals; plain HTML forms use the same reviewed pipeline',async()=>{
 const runtime=await openHandset()
 try {
  const {cookie}=await signIn(runtime)
  const bad=minimalDataset(940)
  bad.entries.push({...bad.entries[0],id:'synthetic-handset-944',kind:'callback',parentEntryId:'synthetic-handset-945'})
  for(const source of [Buffer.from('{broken'),bad,[minimalDataset(950),{...minimalDataset(950),name:'Conflicting duplicate'}]]) {
   const uploadId=await uploadDataset(runtime,cookie,source)
   const response=await importCall(runtime,cookie,'plan',{uploadId})
   assert.equal(response.status,422,await response.clone().text())
   const result=await response.json()
   assert.ok(result.error.startsWith('source_'))
   assert.equal(typeof result.details.reason,'string')
   assert.deepEqual(await nativeDatasets(runtime,cookie),[])
  }
  const form=await runtime.request('/app/import/upload',{method:'POST',headers:{origin:runtime.origin,cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({source:'queue-dataset',name:'queue-dataset.json',sourceJson:JSON.stringify(minimalDataset(960))})})
  assert.equal(form.status,200,await form.clone().text())
  const html=await form.text(),planId=html.match(/name="planId" value="([^"]+)"/)[1],fingerprint=html.match(/name="reviewedFingerprint" value="([^"]+)"/)[1]
  assert.deepEqual(await nativeDatasets(runtime,cookie),[])
  const apply=confirm=>runtime.request('/app/import/apply',{method:'POST',headers:{origin:runtime.origin,cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({source:'queue-dataset',planId,reviewedFingerprint:fingerprint,...(confirm?{confirm}:{})})})
  assert.equal((await apply()).status,400)
  const approved=await apply('I approve this exact fingerprint and these differences')
  assert.equal(approved.status,200,await approved.clone().text())
  await finishImport(runtime,cookie,'apply',{planId,fingerprint})
  assert.equal((await nativeDatasets(runtime,cookie))[0].dataset.id,'synthetic-handset-960')
  await finishImport(runtime,cookie,'undo',{planId})
  assert.deepEqual(await nativeDatasets(runtime,cookie),[])
 } finally { await runtime.close() }
})
