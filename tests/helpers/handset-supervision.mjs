import assert from 'node:assert/strict'
import { post, signIn } from './handset-auth.mjs'
import { queueFixture } from './handset-queues.mjs'
import { importDataset } from './handset-import.mjs'
import { metricDataset, metricConfig } from './handset-metrics.mjs'

export async function supervisionFixture(runtime,cookie){
 cookie??=(await signIn(runtime)).cookie
 const queues=await queueFixture(runtime,cookie),base='/api/handset/supervision'
 const dataset=metricDataset()
 for(const entry of dataset.entries){entry.queueId=entry.queueId==='queue-A'?queues.sales.id:queues.support.id;if(entry.agentId)entry.agentId=queues.english}
 for(const segment of dataset.agents)segment.agentId=queues.english
 await importDataset(runtime,cookie,dataset)
 for(const q of [queues.sales,queues.support])assert.equal((await post(runtime,'/api/handset/metrics/config',metricConfig(q.id),{cookie})).status,201)
 const send=async(path,value,actor=cookie,expected=200)=>{
  const response=await post(runtime,base+path,value,{cookie:actor})
  assert.equal(response.status,expected,await response.clone().text());return response.json()
 }
 const read=async(path='',actor=cookie,expected=200)=>{
  const response=await runtime.request(base+path,{headers:{cookie:actor}})
  assert.equal(response.status,expected,await response.clone().text());return response.json()
 }
 const grant=(operatorId,queueId,canIntervene=true)=>send('/grants',{operatorId,queueId,canIntervene,expiresAt:Date.now()+3600000,confirm:'approve supervision scope'},cookie,201)
 async function personSession(operatorId){
  const person=(await runtime.sql('SELECT email FROM oa_operators WHERE id=?',operatorId)).results[0]
  return (await signIn({...runtime,ownerEmail:person.email})).cookie
 }
 return {...queues,base,queueBase:queues.base,queueRead:queues.read,cookie,dataset,send,read,grant,personSession}
}
