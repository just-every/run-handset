import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'
import { metricDataset,metricConfig } from './helpers/handset-metrics.mjs'
import { importDataset } from './helpers/handset-import.mjs'

test('Reviewed queue observations reconcile exact service levels, agent durations, historical snapshots and scheduled report contents',async()=>{
 const runtime=await openHandset()
 try{
  const {cookie}=await signIn(runtime),headers={cookie}
  const send=async(path,data,status=200)=>{const response=await post(runtime,'/api/handset/metrics/'+path,data,headers);assert.equal(response.status,status,await response.clone().text());return response.json()}
  const live=async(queueId='queue-A')=>{const response=await runtime.request('/api/handset/metrics/live?queueId='+queueId,{headers});assert.equal(response.status,200,await response.clone().text());return response.json()}
  await importDataset(runtime,cookie,metricDataset())
  let config=await send('config',metricConfig(),201)
  let report=await live()
  assert.equal(report.provisional,0);assert.equal(report.finalized,true)
  assert.deepEqual(report.serviceLevel,{numerator:2,denominator:5,value:0.4})
  assert.equal(report.asaSeconds.value,17.5)
  assert.deepEqual(report.abandonment,{numerator:1,denominator:5,value:0.2})
  assert.equal(report.averageAbandonSeconds.value,40)
  assert.equal(report.ahtSeconds.value,60)
  assert.equal(report.totals.talkSeconds,160);assert.equal(report.totals.holdSeconds,40);assert.equal(report.totals.wrapSeconds,40)
  assert.equal(report.totals.offered,6);assert.equal(report.totals.arrivals,6)
  const agent=report.agents['synthetic-handset-agent-1']
  assert.deepEqual(agent.durations,{available:200,ringing:60,talk:160,hold:40,wrap:40,break:30,unavailable:100,'logged-out':60})
  assert.equal(agent.staffedSeconds,600);assert.equal(agent.loggedInSeconds,630);assert.equal(agent.occupancy.value,0.4)
  assert.equal(agent.answeredOffers,4);assert.equal(agent.missedOffers,1)
  const final=await send('finalize',{queueId:'queue-A',configRevision:config.revision},201)
  const history=await (await runtime.request('/api/handset/metrics/history/'+final.id,{headers})).json()
  for(const key of ['totals','serviceLevel','asaSeconds','abandonment','averageAbandonSeconds','ahtSeconds','agents','sourceHash'])assert.deepEqual(history[key],report[key])
  config=await send('config',{...config,method:'exclude-abandons'},201)
  assert.deepEqual((await live()).serviceLevel,{numerator:2,denominator:4,value:0.5})
  config=await send('config',{...config,method:'include-abandons',shortSeconds:0},201)
  report=await live()
  assert.deepEqual(report.serviceLevel,{numerator:2,denominator:6,value:1/3})
  assert.deepEqual(report.abandonment,{numerator:2,denominator:6,value:1/3})
  assert.equal(report.averageAbandonSeconds.value,21.5)
  assert.equal(history.sourceHash,report.sourceHash,'formula changes preserve original source observations')
  config=await send('config',{...config,targetSeconds:30},201)
  const changedTarget=await live()
  assert.deepEqual(changedTarget.serviceLevel,{numerator:4,denominator:6,value:2/3})
  assert.equal(changedTarget.sourceHash,history.sourceHash)
  config=await send('config',{...config,targetSeconds:20},201)
  report=await live()
  await send('config',metricConfig('queue-B'),201)
  const b=await live('queue-B')
  assert.equal(b.totals.offered,2);assert.equal(b.totals.transfers,1);assert.equal(b.totals.overflows,1);assert.equal(b.totals.callbacks,1);assert.equal(b.totals.arrivals,0)
  assert.deepEqual(b.callbackParents,[{id:'synthetic-handset-entry-9',parentEntryId:'synthetic-handset-entry-3',callId:'synthetic-handset-call-3'}])
  assert.equal((await live()).totals.offered,6)
  await send('config',metricConfig('queue-empty'),201)
  const empty=await live('queue-empty')
  for(const name of ['serviceLevel','asaSeconds','abandonment','averageAbandonSeconds','ahtSeconds'])assert.equal(empty[name].value,null,name)
  await send('schedule',{queueId:'queue-A',configRevision:config.revision,dueAt:Date.now(),recipient:'synthetic-handset-99@example.test',confirm:'schedule this owner report'},403)
  const job=await send('schedule',{queueId:'queue-A',configRevision:config.revision,dueAt:Date.now(),recipient:runtime.ownerEmail,confirm:'schedule this owner report'},201)
  const before=runtime.mails.length
  await runtime.scheduled()
  const schedules=await (await runtime.request('/api/handset/metrics',{headers})).json()
  assert.equal(schedules.schedules.find(s=>s.id===job.id).state,'accepted')
  assert.equal(runtime.mails.length,before+1)
  const mail=runtime.mails.at(-1),received=JSON.parse(mail.content.find(p=>p.type==='text/plain').value)
  assert.equal(mail.personalizations[0].to[0].email,runtime.ownerEmail)
  for(const key of ['totals','serviceLevel','asaSeconds','abandonment','averageAbandonSeconds','ahtSeconds','agents','sourceHash'])assert.deepEqual(received[key],report[key])
  assert.equal(received.config.timezone,'America/Chicago')
  await send('run',{});assert.equal(runtime.mails.length,before+1,'replayed scheduler sends once')
  assert.equal((await post(runtime,'/api/handset/metrics/config',metricConfig('foreign'))).status,401)
  assert.equal((await post(runtime,'/api/handset/metrics/config',metricConfig('foreign'),{cookie,origin:'https://example.test'})).status,403)
 }finally{await runtime.close()}
})

test('Metric sources reject overlapping states and inconsistent correlation; provisional entries cannot be finalized and formulas reject stale edits',async()=>{
 const runtime=await openHandset()
 try{
  const {cookie}=await signIn(runtime),headers={cookie}
  const fixture=metricDataset()
  // Malformed public upload is rejected before any native target is written.
  const overlapping=structuredClone(fixture);overlapping.agents[1].startAt=overlapping.agents[0].startAt
  await assert.rejects(()=>importDataset(runtime,cookie,overlapping))
  assert.equal((await (await runtime.request('/api/handset/metrics/datasets',{headers})).json()).datasets.length,0)
  const partial=structuredClone(fixture);delete partial.entries[0].closedAt
  await importDataset(runtime,cookie,partial)
  const response=await post(runtime,'/api/handset/metrics/config',metricConfig(),headers)
  assert.equal(response.status,201,await response.clone().text())
  const config=await response.json()
  assert.equal((await (await runtime.request('/api/handset/metrics/live?queueId=queue-A',{headers})).json()).provisional,1)
  const denied=await post(runtime,'/api/handset/metrics/finalize',{queueId:'queue-A',configRevision:config.revision},headers)
  assert.equal(denied.status,409);assert.equal((await denied.json()).error,'provisional_entries_remain')
  assert.equal((await post(runtime,'/api/handset/metrics/config',metricConfig(),headers)).status,409)
  await importDataset(runtime,cookie,fixture,true)
  assert.equal((await (await runtime.request('/api/handset/metrics/live?queueId=queue-A',{headers})).json()).provisional,0)
  assert.equal((await post(runtime,'/api/handset/metrics/finalize',{queueId:'queue-A',configRevision:config.revision},headers)).status,201)
 }finally{await runtime.close()}
})
