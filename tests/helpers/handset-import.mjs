import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { post } from './handset-auth.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
export const importCall=(runtime,cookie,action,body,headers={})=>post(runtime,'/api/operator/import/'+action,body,{cookie,'x-import-source':'queue-dataset',...headers})
export async function importResult(runtime,cookie,action,body,expected=200) {
 const response=await importCall(runtime,cookie,action,body)
 assert.equal(response.status,expected,`${action}: ${await response.clone().text()}`)
 return response.json()
}
export async function uploadDataset(runtime,cookie,dataset) {
 const bytes=Buffer.isBuffer(dataset)?dataset:Buffer.from(JSON.stringify(dataset)),totalChunks=Math.ceil(bytes.length/65536),bundleSha256=hash(bytes)
 let uploadId
 for(let index=totalChunks-1;index>=0;index--) {
  const chunk=bytes.subarray(index*65536,(index+1)*65536)
  const result=await importResult(runtime,cookie,'uploads',{...(uploadId?{uploadId}:{}),name:'queue-dataset.json',bundleSha256,totalBytes:bytes.length,totalChunks,index,chunkSha256:hash(chunk),base64:chunk.toString('base64')})
  uploadId=result.uploadId
 }
 return uploadId
}
export async function planDataset(runtime,cookie,dataset,catchup=false) {
 const uploadId=await uploadDataset(runtime,cookie,dataset)
 return importResult(runtime,cookie,'plan',{uploadId,...(catchup?{catchup:true}:{})})
}
export async function finishImport(runtime,cookie,action,plan) {
 const input={planId:plan.planId,...(action==='apply'?{reviewedFingerprint:plan.fingerprint}:{})}
 for(let step=0;step<100;step++) {
  const result=await importResult(runtime,cookie,action,input)
  if(result.state==='cancelled'||['completed','undone','rolled_back'].includes(result.job?.state))return result
  assert.ok(['queued','applying','undoing','rolling_back'].includes(result.job?.state),JSON.stringify(result))
 }
 assert.fail('Bounded import did not finish')
}
export async function importDataset(runtime,cookie,dataset,catchup=false) {
 const plan=await planDataset(runtime,cookie,dataset,catchup)
 const applied=await finishImport(runtime,cookie,'apply',plan)
 const report=await importResult(runtime,cookie,'reconcile',{planId:plan.planId})
 assert.equal(report.ok,true,JSON.stringify(report))
 return {plan,...applied,report}
}
export async function nativeDatasets(runtime,cookie) {
 const response=await runtime.request('/api/handset/metrics/datasets',{headers:{cookie}})
 assert.equal(response.status,200,await response.clone().text())
 return (await response.json()).datasets
}
export function minimalDataset(n=600) {
 return {id:`synthetic-handset-${n}`,name:'Historical queue observations',entries:[{id:`synthetic-handset-${n+1}`,callId:`synthetic-handset-${n+2}`,queueId:`synthetic-handset-${n+3}`,kind:'inbound',enteredAt:1792454400000,answeredAt:1792454405000,closedAt:1792454465000,talkSeconds:40,holdSeconds:10,wrapSeconds:10}],agents:[]}
}
