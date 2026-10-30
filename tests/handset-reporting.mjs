import { callReportsFixture,callReportStart,callReportNow } from './helpers/handset-call-reports.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'
import { metricDataset,metricConfig } from './helpers/handset-metrics.mjs'
import { exportFixture, archiveEdge, sftpEdge, range, encryptionKey, sha } from './helpers/handset-exports.mjs'
import { runSftp } from '../src/handset/exports/sftp.mjs'
import { knownWeekFixture,analyticsStart,analyticsEnd,analyticsNow } from './helpers/handset-analytics.mjs'
import { importDataset,nativeDatasets } from './helpers/handset-import.mjs'
import { createEdges } from './helpers/handset-edges.mjs'

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

const decode=async(name,bytes,jobId)=>{
 const key=await crypto.subtle.importKey('raw',Buffer.from(encryptionKey,'hex'),'AES-GCM',false,['decrypt']),fileKey=name.slice(jobId.length+1).replace(/\.(?:wav|json|manifest\.json)\.aes$/,'')
 return Buffer.from(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12),additionalData:Buffer.from(jobId+':'+fileKey)},key,bytes.subarray(12)))
}
const csvUrl='/csv?'+new URLSearchParams(Object.fromEntries(Object.entries(range).map(([k,v])=>[k,String(v)])))

test('Call-log CSV preserves every selected call and leg with timezone and explicit missing billing provenance through native admin doors',async()=>{
 const f=await exportFixture()
 try{
  const admin=await f.persona('synthetic-handset-3500','admin'),supervisor=await f.persona('synthetic-handset-3501')
  const one=await f.media(1),two=await f.media(2,{transcript:false})
  const monthCalls=[]
  for(let index=0;index<600;index++){
   const receipt=await f.callback({CallSid:'synthetic-handset-'+(4000+index),CallStatus:'completed',SequenceNumber:'0',Timestamp:'Thu, 15 Oct 2026 16:00:00 GMT',CallDuration:'40'})
   assert.equal(receipt.status,200,await receipt.clone().text());monthCalls.push((await receipt.json()).recordId)
  }
  const leg=await f.callback({CallSid:'synthetic-handset-3502',ParentCallSid:'synthetic-handset-3001',CallStatus:'completed',SequenceNumber:'0',Timestamp:'Thu, 15 Oct 2026 16:01:00 GMT',CallDuration:'30'});assert.equal(leg.status,200,await leg.clone().text());const legId=(await leg.json()).recordId
  const disposition=await post(f.runtime,'/api/handset/records',{kind:'disposition',sourceId:'synthetic-handset-3503',occurredAt:range.from+1000,parentId:one.callId,caseId:one.caseId,data:{text:'=unsafe spreadsheet formula'}},f.headers);assert.equal(disposition.status,201)
  const units=await post(f.runtime,'/api/handset/records',{kind:'usage',sourceId:'synthetic-handset-3505',occurredAt:range.from+1000,parentId:one.callId,caseId:one.caseId,data:{amountCents:17,currency:'USD',billedUnits:'2',billedUnitKind:'minutes'}},f.headers);assert.equal(units.status,201,await units.clone().text())
  const response=await f.runtime.request(f.base+csvUrl,{headers:admin});assert.equal(response.status,200,await response.clone().text());const csv=await response.text()
  assert.equal(response.headers.get('x-handset-call-count'),String(2+monthCalls.length));assert.equal(response.headers.get('x-handset-leg-count'),'1');assert.equal(response.headers.get('x-handset-row-count'),String(3+monthCalls.length))
  for(const id of [one.callId,two.callId,...monthCalls,legId,one.recordingId,two.recordingId])assert.ok(csv.includes(id),id)
  assert.ok(csv.includes('"2","minutes","","owner supplied; unverified","170000"'),'native entered billed units and their provenance survive export');assert.ok(csv.includes('America/Chicago'));assert.ok(csv.includes('11:00:00 GMT-05:00'));assert.ok(csv.includes("'=unsafe spreadsheet formula"));assert.ok(csv.includes('carrier billed units not supplied'));assert.equal(sha(Buffer.from(csv)),response.headers.get('x-handset-csv-sha256'))
  const outside=await f.runtime.request(f.base+'/csv?'+new URLSearchParams({...range,from:String(range.to),to:String(range.to+86400000)}),{headers:admin});assert.equal(outside.headers.get('x-handset-call-count'),'0')
  for(const path of ['',csvUrl,'/jobs/synthetic-handset-3504','/settings']){const r=await f.runtime.request(f.base+path,{headers:supervisor});assert.equal(r.status,403,await r.clone().text())}
  for(const [path,body] of [['/jobs',{}],['/connectors',{}],['/schedules',{}],['/tick',{}]])assert.equal((await post(f.runtime,f.base+path,body,supervisor)).status,403)
  assert.equal((await f.runtime.request('/app/exports',{headers:supervisor})).status,403)
  assert.equal((await f.runtime.request(f.base+csvUrl)).status,401)
  assert.equal((await post(f.runtime,f.base+'/jobs',{})).status,401)
  await f.runtime.sql("UPDATE oa_operators SET role='member',version=version+1 WHERE id=?",'synthetic-handset-3500')
  assert.equal((await f.runtime.request(f.base+csvUrl,{headers:admin})).status,401)
 }finally{await f.runtime.close()}
})

test('Reviewed queue and owner schedules each send one sensitive CSV copy with shown recipient and timezone and stop after authority revocation',async()=>{
 const f=await exportFixture()
 try{
  const media=await f.media(3)
  await f.persona('synthetic-handset-3510')
  const detail=await (await f.runtime.request('/api/handset/cases/'+media.caseId,{headers:f.headers})).json()
  const assigned=await post(f.runtime,'/api/handset/cases/'+media.caseId,{title:detail.current.title,ownerId:'synthetic-handset-1',version:detail.current.version},f.headers);assert.equal(assigned.status,200,await assigned.clone().text())
  const q=await post(f.runtime,'/api/handset/queues',{name:'Support',mode:'longest_idle',skills:[],maxWaitSeconds:120,wrapSeconds:30,maxWaiting:100,overflowKind:'voicemail',confirm:'approve native queue policy'},f.headers);assert.equal(q.status,201,await q.clone().text());const queue=await q.json()
  const entry=await post(f.runtime,'/api/handset/queues/'+queue.id+'/entries',{callId:media.callId,language:'en',skills:[],priority:0},f.headers);assert.equal(entry.status,201,await entry.clone().text())
  const value={...range,queueId:queue.id,recipient:'synthetic-handset-3505@example.test',dueAt:Date.now(),emailCopyPolicy:'I approve sensitive call-log CSV copies to this exact recipient in separate email custody',confirm:'schedule this exact call-log email'}
  assert.equal((await post(f.runtime,f.base+'/schedules',{...value,emailCopyPolicy:undefined},f.headers)).status,403)
  const scheduled=await f.write('/schedules',value)
  const before=f.runtime.mails.length;await f.write('/tick',{},200);await f.write('/tick',{},200);await f.runtime.scheduled()
  assert.equal(f.runtime.mails.length,before+1)
  const mail=f.runtime.mails.at(-1),attachment=mail.attachments[0],csv=Buffer.from(attachment.content,'base64').toString()
  assert.equal(mail.personalizations[0].to[0].email,value.recipient);assert.ok(csv.includes(media.callId));assert.ok(csv.includes(queue.id));assert.ok(csv.includes('America/Chicago'));assert.ok(mail.content.some(part=>part.value.includes('Calls: 1. Legs: 0.')))
  const state=(await f.get()).schedules.find(s=>s.id===scheduled.id);assert.equal(state.state,'accepted');assert.equal(state.call_count,1);assert.equal(state.csv_hash,sha(Buffer.from(csv)))
  const owned=await f.write('/schedules',{...value,queueId:undefined,ownerId:'synthetic-handset-1',dueAt:Date.now()})
  await f.runtime.scheduled();await f.write('/tick',{},200)
  assert.equal(f.runtime.mails.length,before+2)
  const ownedCsv=Buffer.from(f.runtime.mails.at(-1).attachments[0].content,'base64').toString()
  assert.ok(ownedCsv.includes(media.callId));assert.ok(ownedCsv.includes('"synthetic-handset-1"'))
  assert.equal((await f.get()).schedules.find(s=>s.id===owned.id).call_count,1)
  const other=await f.runtime.request(f.base+csvUrl+'&ownerId=synthetic-handset-3510',{headers:f.headers});assert.equal(other.headers.get('x-handset-call-count'),'0');assert.ok(!(await other.text()).includes(media.callId))
  const held=await f.write('/schedules',{...value,queueId:undefined,ownerId:'synthetic-handset-1',dueAt:Date.now()+1000})
  await f.runtime.sql("UPDATE oa_operators SET version=version+1 WHERE id=?",'synthetic-handset-1');await f.runtime.scheduled(Date.now()+2000)
  assert.equal(f.runtime.mails.length,before+2);const stored=(await f.runtime.sql('SELECT state FROM hnd_export_schedules WHERE id=?',held.id)).results[0];assert.equal(stored.state,'refused')
 }finally{await f.runtime.close()}
})

test('Official archive edges reconcile encrypted audio, transcripts and unavailable entries after interruption and lost acknowledgements without duplicate files',async()=>{
 for(const provider of ['box','dropbox','google-drive']){
  const edge=archiveEdge(),f=await exportFixture(edge)
  try{
   const available=await f.media(4),unavailable=await f.media(5,{audio:false,transcript:false}),connector=await f.connector(provider),job=await f.archive(connector.id)
   edge.loseResponse()
   const first=await post(f.runtime,f.base+'/jobs/'+job.id+'/run',{credential:'synthetic-handset-3301',encryptionKey},f.headers);assert.equal(first.status,503,await first.clone().text());assert.equal(edge.objects.size,1)
   await f.runtime.restart()
   const complete=await f.write('/jobs/'+job.id+'/run',{credential:'synthetic-handset-3301',encryptionKey},200)
   assert.equal(complete.state,'verified');assert.equal(edge.objects.size,3);assert.equal(new Set(edge.uploads).size,edge.uploads.length)
   const manifestFile=[...edge.objects.values()].find(file=>file.name.includes('.manifest.manifest.json.aes'));assert.ok(manifestFile)
   const manifest=JSON.parse((await decode(manifestFile.name,manifestFile.bytes,job.id)).toString())
   assert.equal(manifest.recordingCount,2);assert.equal(manifest.files.length,4)
   const audio=manifest.files.find(file=>file.kind==='audio'&&file.recordingId===available.recordingId),transcript=manifest.files.find(file=>file.kind==='transcript'&&file.recordingId===available.recordingId),missing=manifest.files.find(file=>file.kind==='audio'&&file.recordingId===unavailable.recordingId)
   assert.equal(audio.sha256,sha(available.bytes));assert.equal(missing.state,'unavailable');assert.equal(missing.reason,'recording_media_unavailable');assert.equal(transcript.transcriptLink,'/api/handset/transcripts/'+available.transcriptId)
   for(const file of manifest.files.filter(file=>file.state==='verified')){const remote=edge.objects.get(file.name);assert.equal(sha(remote.bytes),file.cipherSha256);assert.equal(sha(await decode(file.name,remote.bytes,job.id)),file.sha256)}
   const plainTranscript=JSON.parse((await decode(transcript.name,edge.objects.get(transcript.name).bytes,job.id)).toString());assert.equal(plainTranscript.segments[0].text,'Please call on Tuesday.')
   const count=edge.uploads.length;await f.write('/jobs/'+job.id+'/run',{credential:'synthetic-handset-3301',encryptionKey},200);assert.equal(edge.uploads.length,count)
   const next=await f.archive(connector.id);await f.write('/connectors/'+connector.id+'/revoke',{},200);const requests=edge.requests.length
   assert.equal((await post(f.runtime,f.base+'/jobs/'+next.id+'/run',{credential:'synthetic-handset-3301',encryptionKey},f.headers)).status,409);assert.equal(edge.requests.length,requests);assert.equal(edge.objects.size,3)
  }finally{await f.runtime.close()}
 }
})

test('Archive export approval never substitutes for separate exact-person recording and transcript grants, including revocation during readback',async()=>{
 const edge=archiveEdge(),f=await exportFixture(edge)
 try{
  const media=await f.media(6),connector=await f.connector('dropbox')
  await post(f.runtime,'/api/handset/transcripts/'+media.transcriptId+'/revoke',{personId:'synthetic-handset-1'},f.headers)
  const job=await f.archive(connector.id),complete=await f.write('/jobs/'+job.id+'/run',{credential:'synthetic-handset-3301',encryptionKey},200)
  assert.equal(complete.files.find(file=>file.kind==='transcript').reason,'transcript_access_required')
  assert.equal(edge.objects.size,2)
  const next=await f.archive(connector.id)
  edge.onDownload(async()=>{edge.onDownload(null);await post(f.runtime,'/api/handset/recordings/grants/'+media.grant.id+'/revoke',{},f.headers)})
  const response=await post(f.runtime,f.base+'/jobs/'+next.id+'/run',{credential:'synthetic-handset-3301',encryptionKey},f.headers);assert.equal(response.status,403,await response.clone().text())
  assert.equal((await f.get('/jobs/'+next.id)).state,'interrupted')
  assert.ok(!(await f.get('/jobs/'+next.id)).files.some(file=>file.kind==='manifest'&&file.state==='verified'))
 }finally{await f.runtime.close()}
})

test('Buyer OpenSSH SFTP pins the approved host key, independently reads encrypted files, resumes without duplication and obeys native connector revocation',async()=>{
 const edge=await sftpEdge(),f=await exportFixture()
 try{
  await f.media(7);await f.media(8,{audio:false,transcript:false})
  const connector=await f.connector('sftp',edge.destination),job=await f.archive(connector.id),config={origin:f.runtime.origin,jobId:job.id,encryptionKey,identityFile:edge.identityFile,knownHostsFile:edge.knownHostsFile}
  const network=(url,options)=>f.runtime.request(String(url).slice(f.runtime.origin.length),options)
   await runSftp(config,f.cookie,network)
   assert.equal((await f.get('/jobs/'+job.id)).state,'client_verified');assert.equal(edge.objects.size,3)
   const writes=edge.writes.length;await runSftp(config,f.cookie,network);assert.equal(edge.writes.length,writes)
   const manifestFile=[...edge.objects].find(([name])=>name.includes('.manifest.manifest.json.aes')),manifest=JSON.parse((await decode(manifestFile[0].split('/').at(-1),manifestFile[1],job.id)).toString())
   assert.equal(manifest.recordingCount,2);assert.ok(manifest.files.some(file=>file.state==='unavailable'));assert.ok(manifest.files.some(file=>file.transcriptLink))
   const next=await f.archive(connector.id);await f.write('/connectors/'+connector.id+'/revoke',{},200)
   await assert.rejects(runSftp({...config,jobId:next.id},f.cookie,network),/approve the exact archive/);assert.equal(edge.writes.length,writes)
 }finally{await f.runtime.close();await edge.close()}
})


test('Known-week reports reconcile source legs, confirmed recovery, reporting groups, filtered saved dashboards and owner-only delivery',async()=>{
 const edges=createEdges(),runtime=await openHandset({twilio:true,edges,clockTime:analyticsNow})
 try{
  const {source,calls,recoveries,dataset}=await knownWeekFixture(runtime,edges),headers=source.headers
  const send=async(path,data,status=201)=>{const r=await post(runtime,'/api/handset/metrics/'+path,data,headers);assert.equal(r.status,status,await r.clone().text());return r.json()}
  const records=await Promise.all(calls.map(async call=>{
   const r=await runtime.request('/api/handset/records/'+call.recordId,{headers});assert.equal(r.status,200,await r.clone().text());return (await r.json()).record
  }))
  assert.deepEqual(records.map(r=>[new Date(r.occurred_at).toISOString(),JSON.parse(r.data).providerStatus]),[
   ['2026-11-01T06:15:00.000Z','no-answer'],['2026-11-01T07:15:00.000Z','failed'],['2026-11-02T15:00:00.000Z','completed'],['2026-11-03T16:00:00.000Z','busy'],['2026-11-04T17:00:00.000Z','no-answer'],['2026-11-05T18:00:00.000Z','canceled'],['2026-11-08T00:00:00.000Z','no-answer'],
  ])
  assert.deepEqual((await nativeDatasets(runtime,source.cookie)).map(row=>row.dataset),[dataset],'the reviewed queue source survives the import door with every entry, relationship and agent segment')
  assert.ok(dataset.entries.every(entry=>!records.some(record=>record.id===entry.callId)),'historical queue identities are independent of canonical carrier calls')
  await send('groups',{number:'+15125550125',team:'Support',location:'Austin',revision:0})
  await send('groups',{number:'+15125550999',team:'Sales',location:'Dallas',revision:0})
  await send('groups',{number:'+15125550125',team:'Wrong',location:'Wrong',revision:0},409)
  const configured=await post(runtime,'/api/handset/metrics/config',metricConfig('*',0,{startAt:analyticsStart,endAt:analyticsEnd}),headers);assert.equal(configured.status,201,await configured.clone().text());const config=await configured.json()
  const response=await runtime.request('/api/handset/metrics/live?queueId=*',{headers});assert.equal(response.status,200);const report=await response.json(),n=report.native
  assert.deepEqual(n.totals,{volume:6,answered:1,missed:5,unknown:0,legs:1})
  assert.deepEqual(n.sourceCalls.map(c=>c.id),calls.slice(0,6).map(c=>c.recordId))
  assert.deepEqual(n.sourceCalls.map(c=>[c.id,c.occurredAt,c.status,c.answered,c.missed]),records.slice(0,6).map((r,index)=>[r.id,r.occurred_at,JSON.parse(r.data).providerStatus,index===2,index!==2]))
  assert.deepEqual(n.byPerson,[{label:'synthetic-handset-1',volume:6,answered:1,missed:5,handoffs:0,pendingWork:0,contained:0,converted:0,serviceSeconds:0,sourceCallIds:calls.slice(0,6).map(c=>c.recordId)}])
  assert.deepEqual(n.byHour.map(h=>[h.volume,h.missed]),[[1,1],[1,1],[1,0],[1,1],[1,1],[1,1]])
  assert.match(n.byHour[0].label,/01.*GMT-05:00/);assert.match(n.byHour[1].label,/01.*GMT-06:00/)
  assert.deepEqual(n.byNumber.map(r=>[r.label,r.volume,r.missed]),[['+15125550125',6,5]])
  assert.equal(n.recovery.cases,2);assert.equal(n.recovery.confirmed,1);assert.deepEqual(n.recovery.confirmedCaseIds,[calls[1].caseId])
  assert.deepEqual(new Set(n.recovery.caseIds),new Set(recoveries.map(r=>r.case_id)))
  assert.deepEqual([n.fcr.numerator,n.fcr.denominator,n.fcr.value],[1,2,0.5]);assert.deepEqual(n.fcr.eligibleCallIds,calls.slice(0,2).map(c=>c.recordId));assert.deepEqual(n.fcr.repeatCallIds,[calls[0].recordId]);assert.deepEqual(n.fcr.excluded,{immature:3,unknownIdentity:0,repeatContact:1})
  assert.equal(n.csat.responseRate,null);assert.equal(n.csat.mean,null)
  assert.deepEqual(n.byTeam.map(g=>[g.label,g.volume,g.answered,g.missed]),[['Support',6,1,5]])
  assert.deepEqual(n.byLocation.map(g=>[g.label,g.volume,g.answered,g.missed]),[['Austin',6,1,5]])
  assert.deepEqual(n.fcr.resolvedCallIds,[calls[1].recordId])
  assert.equal(edges.bookings.size,1)
  assert.equal(recoveries.length,3);assert.equal(new Set(recoveries.map(r=>r.case_id)).size,2)
  const csvResponse=await runtime.request('/api/handset/metrics/csv?queueId=*',{headers});assert.equal(csvResponse.status,200);const csv=await csvResponse.text()
  assert.equal(csv.trim().split('\r\n').length,7);for(const c of calls.slice(0,6))assert.ok(csv.includes(c.recordId));assert.ok(!csv.includes(calls[6].recordId));assert.ok(csv.includes('GMT-05:00'));assert.ok(csv.includes('GMT-06:00'))
  const schedule={queueId:'*',configRevision:config.revision,recipient:runtime.ownerEmail,dueAt:analyticsNow,confirm:'schedule this owner report'}
  assert.equal((await post(runtime,'/api/handset/metrics/schedule',{...schedule,recipient:'synthetic-handset-restricted@example.test'},headers)).status,403)
  assert.equal((await post(runtime,'/api/handset/metrics/schedule',schedule,headers)).status,201)
  const before=runtime.mails.length;await runtime.scheduled();await runtime.scheduled();assert.equal(runtime.mails.length,before+1)
  const received=JSON.parse(runtime.mails.at(-1).content.find(p=>p.type==='text/plain').value)
  assert.deepEqual(received.native,n);assert.equal(received.config.timezone,'America/Chicago')
  const finalResponse=await post(runtime,'/api/handset/metrics/finalize',{queueId:'*',configRevision:config.revision},headers);assert.equal(finalResponse.status,201);const final=await finalResponse.json()
  const history=await (await runtime.request('/api/handset/metrics/history/'+final.id,{headers})).json();assert.deepEqual(history.native,n)

  // A separate imported population supplies queue legs and staffed timelines.
  // Its exact formulas do not qualify the canonical carrier calls above.
  const fullWeek={startAt:analyticsStart,endAt:analyticsEnd}
  let queue=await send('config',metricConfig('queue-A',0,fullWeek))
  const live=async(suffix)=>{const r=await runtime.request('/api/handset/metrics/'+suffix,{headers});assert.equal(r.status,200,await r.clone().text());return r.json()}
  let a=await live('live?queueId=queue-A')
  assert.deepEqual(a.native.sourceCalls,[],'an imported queue identity does not manufacture a canonical carrier call')
  assert.deepEqual(a.sourceEntryIds,dataset.entries.slice(0,6).map(e=>e.id))
  assert.deepEqual(a.totals,{offered:6,arrivals:6,transfers:0,overflows:0,callbacks:0,answered:4,abandoned:2,eligibleAbandons:1,shortAbandons:1,withinTarget:2,completedHandled:4,talkSeconds:160,holdSeconds:40,wrapSeconds:40})
  assert.deepEqual(a.serviceLevel,{numerator:2,denominator:5,value:0.4})
  assert.deepEqual(a.asaSeconds,{numerator:70,denominator:4,value:17.5})
  assert.deepEqual(a.abandonment,{numerator:1,denominator:5,value:0.2})
  assert.deepEqual(a.averageAbandonSeconds,{numerator:40,denominator:1,value:40})
  assert.deepEqual(a.ahtSeconds,{numerator:240,denominator:4,value:60})
  const agent=a.agents['synthetic-handset-agent-1']
  assert.deepEqual(agent.durations,{available:200,ringing:60,talk:160,hold:40,wrap:40,break:30,unavailable:100,'logged-out':60})
  assert.equal(agent.staffedSeconds,600);assert.equal(agent.loggedInSeconds,630)
  assert.deepEqual(agent.occupancy,{numerator:240,denominator:600,value:0.4});assert.equal(agent.answeredOffers,4);assert.equal(agent.missedOffers,1)
  const retainedQueue=await send('finalize',{queueId:'queue-A',configRevision:queue.revision})
  const queueHistory=await live('history/'+retainedQueue.id)
  await send('schedule',{...schedule,queueId:'queue-A',configRevision:queue.revision})
  const queueMailCount=runtime.mails.length;await runtime.scheduled();await runtime.scheduled();assert.equal(runtime.mails.length,queueMailCount+1)
  const deliveredQueue=JSON.parse(runtime.mails.at(-1).content.find(p=>p.type==='text/plain').value)
  for(const key of ['sourceEntryIds','totals','serviceLevel','asaSeconds','abandonment','averageAbandonSeconds','ahtSeconds','agents','callbackParents','sourceHash']){
   assert.deepEqual(queueHistory[key],a[key],'retained queue '+key)
   assert.deepEqual(deliveredQueue[key],a[key],'scheduled queue '+key)
  }
  queue=await send('config',{...queue,method:'exclude-abandons'})
  assert.deepEqual((await live('live?queueId=queue-A')).serviceLevel,{numerator:2,denominator:4,value:0.5})
  queue=await send('config',{...queue,method:'include-abandons',shortSeconds:0})
  a=await live('live?queueId=queue-A')
  assert.deepEqual(a.serviceLevel,{numerator:2,denominator:6,value:1/3});assert.deepEqual(a.abandonment,{numerator:2,denominator:6,value:1/3})
  assert.deepEqual(a.averageAbandonSeconds,{numerator:43,denominator:2,value:21.5})
  await send('config',metricConfig('queue-B',0,fullWeek))
  const b=await live('live?queueId=queue-B')
  assert.deepEqual(b.native.sourceCalls,[])
  assert.deepEqual(b.sourceEntryIds,dataset.entries.slice(6).map(e=>e.id))
  assert.deepEqual(b.totals,{offered:2,arrivals:0,transfers:1,overflows:1,callbacks:1,answered:1,abandoned:1,eligibleAbandons:1,shortAbandons:0,withinTarget:1,completedHandled:2,talkSeconds:15,holdSeconds:0,wrapSeconds:0})
  assert.deepEqual(b.serviceLevel,{numerator:1,denominator:2,value:0.5});assert.equal(b.asaSeconds.value,2);assert.equal(b.ahtSeconds.value,7.5);assert.equal(b.averageAbandonSeconds.value,10)
  assert.deepEqual(b.callbackParents,[{id:dataset.entries[8].id,parentEntryId:dataset.entries[2].id,callId:dataset.entries[2].callId}])
  assert.equal((await live('live?queueId=queue-A')).totals.arrivals,6)
  const filtered=await live('live?queueId=*&outcome=missed&team=Support&location=Austin')
  assert.deepEqual(filtered.native.sourceCalls.map(c=>c.id),[calls[0],calls[1],calls[3],calls[4],calls[5]].map(c=>c.recordId))
  assert.deepEqual(filtered.native.totals,{volume:5,answered:0,missed:5,unknown:0,legs:0})
  const firstHour=await live('live?'+new URLSearchParams({queueId:'*',hour:n.byHour[0].label}))
  assert.deepEqual(firstHour.native.fcr.repeatCallIds,[calls[0].recordId],'filtering out a repeat cannot turn it into FCR')
  assert.equal(firstHour.native.fcr.value,0)
  assert.equal((await live('live?queueId=*&team=Sales')).native.totals.volume,0)
  for(const query of ['team=','team=Support&team=Sales','ownerId=synthetic-handset-2'])assert.equal((await runtime.request('/api/handset/metrics/live?queueId=*&'+query,{headers})).status,400)
  const definition={name:'Austin missed calls',queueId:'*',configRevision:config.revision,filters:{team:'Support',location:'Austin',outcome:'missed'},groups:['hour','team','location'],metrics:['volume','missed']}
  let dashboard=await send('dashboards',definition)
  const dashPath='dashboards/'+dashboard.id
  assert.deepEqual((await live(dashPath)).native.sourceCalls,filtered.native.sourceCalls)
  assert.deepEqual((await live(dashPath)).dashboard,dashboard)
  assert.equal((await runtime.request('/api/handset/metrics/'+dashPath+'?team=Sales',{headers})).status,400)
  const dashboardCsv=await (await runtime.request('/api/handset/metrics/'+dashPath+'/csv',{headers})).text()
  assert.equal(dashboardCsv.trim().split('\r\n').length,6);assert.ok(!dashboardCsv.includes(calls[2].recordId));assert.ok(dashboardCsv.includes('Austin'))
  const dashSchedule={...schedule,dashboardId:dashboard.id,dashboardRevision:dashboard.revision}
  await send('schedule',{...dashSchedule,recipient:'synthetic-handset-restricted@example.test'},403)
  await send('schedule',dashSchedule)
  const originalDashboard=structuredClone(dashboard)
  dashboard=await send('dashboards',{...dashboard,name:'One DST hour',filters:{hour:n.byHour[1].label},groups:['hour'],metrics:['missed']})
  await send('dashboards',{...originalDashboard,name:'Stale edit'},409)
  await send('schedule',dashSchedule,409)
  await send('finalize',{queueId:'*',configRevision:config.revision,dashboardId:dashboard.id,dashboardRevision:originalDashboard.revision},409)
  const one=await live(dashPath)
  assert.deepEqual(one.native.totals,{volume:1,answered:0,missed:1,unknown:0,legs:0})
  assert.deepEqual(one.native.recovery.confirmedCaseIds,[calls[1].caseId]);assert.equal(one.native.fcr.value,1)
  const retained=await send('finalize',{queueId:'*',configRevision:config.revision,dashboardId:dashboard.id,dashboardRevision:dashboard.revision})
  await send(dashPath+'/delete',{revision:originalDashboard.revision},409)
  await send(dashPath+'/delete',{revision:dashboard.revision},200)
  assert.equal((await runtime.request('/api/handset/metrics/'+dashPath,{headers})).status,404)
  const mailCount=runtime.mails.length;await runtime.scheduled();assert.equal(runtime.mails.length,mailCount+1)
  const savedDelivery=JSON.parse(runtime.mails.at(-1).content.find(p=>p.type==='text/plain').value)
  assert.deepEqual(savedDelivery.dashboard,originalDashboard);assert.deepEqual(savedDelivery.native.totals,filtered.native.totals)
  assert.deepEqual((await live('history/'+retained.id)).native,one.native)
  await send('groups',{number:'+15125550125',team:'Field service',location:'Houston',revision:1})
  assert.deepEqual((await live('live?queueId=*')).native.byLocation.map(g=>[g.label,g.volume]),[['Houston',6]])
  assert.deepEqual((await live('history/'+final.id)).native.byLocation,n.byLocation,'retained reports keep captured assignments')
  await runtime.restart();headers.cookie=(await signIn(runtime)).cookie
  assert.equal((await live('history/'+retained.id)).native.totals.volume,1)
  const pending=await send('schedule',{...schedule,dueAt:analyticsNow+1000})

  await post(runtime,'/api/handset/metrics/config',metricConfig('synthetic-handset-foreign',0,{startAt:analyticsStart,endAt:analyticsEnd}),headers)
  assert.equal((await (await runtime.request('/api/handset/metrics/live?queueId=synthetic-handset-foreign',{headers})).json()).native.totals.volume,0)
  assert.equal((await runtime.request('/api/handset/metrics/csv?queueId=*')).status,401)
  await post(runtime,'/auth/operator/status',{operatorId:'synthetic-handset-2',status:'active'},headers)
  const member=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  for(const path of ['/api/handset/metrics/live?queueId=*','/api/handset/metrics/csv?queueId=*','/app/reports/queues/live?queueId=*','/api/handset/metrics/dashboards','/api/handset/metrics/groups','/api/handset/metrics/history/'+retained.id])assert.equal((await runtime.request(path,{headers:{cookie:member.cookie}})).status,403)
  for(const [path,data] of [['dashboards',definition],['groups',{number:'+15125550125',team:'Bad',location:'Bad',revision:2}],[dashPath+'/delete',{revision:2}]])assert.equal((await post(runtime,'/api/handset/metrics/'+path,data,{cookie:member.cookie})).status,403)
  assert.equal((await post(runtime,'/auth/operator/role',{operatorId:'synthetic-handset-2',role:'owner'},headers)).status,200)
  assert.equal((await post(runtime,'/auth/operator/status',{operatorId:'synthetic-handset-1',status:'inactive'},headers)).status,200)
  assert.equal((await runtime.request('/api/handset/metrics/history/'+retained.id,{headers})).status,401)
  const beforeRefusal=runtime.mails.length;await runtime.scheduled(analyticsNow+2000);assert.equal(runtime.mails.length,beforeRefusal)
  assert.equal((await runtime.sql('SELECT state FROM hnd_metric_schedules WHERE id=?',pending.id)).results[0].state,'refused')
 }finally{await runtime.close()}
})

test('Call-bound reports attribute verified handlers and reconcile booking containment and source conversion without substituting case ownership',async()=>{
 const edges=createEdges(),runtime=await openHandset({twilio:true,edges,clockTime:callReportNow})
 try{
  const f=await callReportsFixture(runtime,edges),{source,calls,dataset,handler}=f,headers=source.headers
  const live=async(query='queueId=*')=>{const response=await runtime.request('/api/handset/metrics/live?'+query,{headers});assert.equal(response.status,200,await response.clone().text());return response.json()}
  const report=await live(),n=report.native
  assert.deepEqual(n.totals,{volume:6,answered:4,missed:2,unknown:0,legs:1})
  assert.deepEqual(n.byHandlingUser.map(g=>[g.label,g.volume,g.answered,g.missed,g.serviceSeconds]),[['Unattributed',5,3,2,0],[handler,1,1,0,60]])
  assert.deepEqual(n.recovery.confirmedCaseIds,[calls[4].caseId]);assert.equal(n.recovery.confirmed,1);assert.equal(n.recovery.cases,2)
  assert.equal(calls[5].caseId,calls[1].caseId);assert.ok(!n.conversion.convertedCallIds.includes(calls[5].recordId),'a repeat in the same booked case is not another conversion')
  const failed=await runtime.request('/api/handset/records/'+f.failedRecording.recordId,{headers});assert.equal(JSON.parse((await failed.json()).record.data).providerStatus,'failed')
  assert.deepEqual(n.sourceCalls.map(c=>c.handlingUsers),[[handler],[],[],[],[],[]])
  assert.equal(n.sourceCalls[0].person,'synthetic-handset-1');assert.notEqual(n.sourceCalls[0].person,handler)
  assert.deepEqual(n.sourceCalls[0].handlingOffers.map(o=>[o.offer_id,o.service_seconds]),[[calls[0].offerId,60]])
  assert.deepEqual([n.containment.numerator,n.containment.denominator,n.containment.value],[1,4,0.25])
  assert.deepEqual(n.containment.eligibleCallIds,calls.slice(1,5).map(c=>c.recordId));assert.deepEqual(n.containment.containedCallIds,[calls[1].recordId])
  assert.equal(n.containment.unlinkedOutcomes,2)
  assert.equal(n.receptionist.linkedCalls,4)
  assert.deepEqual(n.receptionist.byKind.map(k=>[k.kind,k.calls,k.confirmedCalls]),[['booking',3,3],['deposit',0,0],['refund',0,0],['crm',3,1],['support',1,1]])
  assert.deepEqual(n.receptionist.states,{confirmed:[calls[1].recordId,calls[2].recordId,calls[4].recordId],pending:[calls[3].recordId],rejected:[calls[4].recordId],escalated:[calls[2].recordId,calls[3].recordId,calls[4].recordId],unstarted:[]})
  assert.deepEqual(n.sourceCalls[2].receptionistWork.steps.filter(s=>s.confirmed).map(s=>s.id).sort(),[f.crm.step.id,f.support.step.id,...n.sourceCalls[2].receptionistWork.steps.filter(s=>s.kind==='booking').map(s=>s.id)].sort())
  assert.equal(n.sourceCalls[3].receptionistWork.steps[0].id,f.uncertain.step.id)
  assert.equal(n.sourceCalls[3].receptionistWork.steps[0].confirmed,false,'a lost acknowledgement is not a confirmed handoff')
  assert.ok(!JSON.stringify(n.receptionist).includes(f.unlinked.id))
  assert.deepEqual((await live('queueId=*&receptionistState=pending')).native.sourceCalls.map(c=>c.id),[calls[3].recordId])
  assert.deepEqual((await live('queueId=*&receptionistState=confirmed&outcome=missed')).native.sourceCalls.map(c=>c.id),[calls[4].recordId])
  assert.deepEqual((await live('queueId=*&receptionistState=rejected')).native.sourceCalls.map(c=>c.id),[calls[4].recordId])
  assert.equal((await live('queueId=*&receptionistState=unstarted')).native.totals.volume,0)
  assert.equal((await runtime.request('/api/handset/metrics/live?queueId=*&receptionistState=done',{headers})).status,400)
  const pendingCsv=await (await runtime.request('/api/handset/metrics/csv?queueId=*&receptionistState=pending',{headers})).text()
  assert.equal(pendingCsv.trim().split('\r\n').length,2);assert.ok(pendingCsv.includes(calls[3].recordId));assert.ok(pendingCsv.includes(f.uncertain.step.id));assert.ok(!pendingCsv.includes(f.crm.step.id));assert.ok(!pendingCsv.includes(f.rejected.step.id))
  const rejectedCsvResponse=await runtime.request('/api/handset/metrics/csv?queueId=*&receptionistState=rejected',{headers})
  assert.equal(rejectedCsvResponse.status,200)
  const rejectedCsv=await rejectedCsvResponse.text(),[rejectedHeader,rejectedRow]=rejectedCsv.trim().split('\r\n').map(line=>JSON.parse('['+line+']'))
  assert.equal(rejectedRow[rejectedHeader.indexOf('call_id')],calls[4].recordId)
  assert.equal(rejectedRow[rejectedHeader.indexOf('rejected_receptionist_effect_ids')],f.rejected.step.id)
  assert.equal(rejectedRow[rejectedHeader.indexOf('pending_receptionist_effect_ids')],'')
  assert.ok(!rejectedCsv.includes(f.uncertain.step.id));assert.ok(!rejectedCsv.includes(f.crm.step.id))

  assert.deepEqual([n.conversion.numerator,n.conversion.denominator,n.conversion.value],[3,6,0.5])
  assert.deepEqual(n.conversion.convertedCallIds,[calls[1],calls[2],calls[4]].map(c=>c.recordId));assert.deepEqual(n.conversion.eligibleCallIds,calls.map(c=>c.recordId))
  assert.deepEqual(n.byTrackingSource.map(g=>[g.label,g.volume,g.contained,g.converted]),[['Winter repairs',6,1,3]])
  assert.deepEqual(n.byTrackingSource.map(g=>[g.label,g.handoffs,g.pendingWork]),[['Winter repairs',1,1]])
  assert.deepEqual((await live('queueId=*&handlingUser='+handler)).native.sourceCalls.map(c=>c.id),[calls[0].recordId])
  assert.equal((await live('queueId=*&handlingUser=synthetic-handset-1')).native.totals.volume,0,'case owner never becomes a handler')
  assert.deepEqual((await live('queueId=*&trackingSource=Winter+repairs&outcome=missed')).native.sourceCalls.map(c=>c.id),calls.slice(4).map(c=>c.recordId))
  const config=await f.write('/api/handset/metrics/config',metricConfig('queue-A',0,{startAt:callReportStart,endAt:callReportNow,repeatWindowHours:24}))
  const queue=await live('queueId=queue-A')
  assert.deepEqual(queue.sourceEntryIds,dataset.entries.slice(0,6).map(e=>e.id))
  assert.deepEqual(queue.sourceEntries,dataset.entries.slice(0,6).map(entry=>({...entry,canonicalCallId:entry.callId})))
  assert.deepEqual(queue.agents[handler].durations,{available:200,ringing:60,talk:160,hold:40,wrap:40,break:30,unavailable:100,'logged-out':60})
  assert.equal(queue.agents[handler].answeredOffers,4);assert.equal(queue.agents[handler].missedOffers,1)
  assert.deepEqual(queue.native.sourceCalls.map(c=>c.id),calls.map(c=>c.recordId),'every queue-A fixture entry reaches the same canonical source population')
  assert.deepEqual(queue.totals,{offered:6,arrivals:6,transfers:0,overflows:0,callbacks:0,answered:4,abandoned:2,eligibleAbandons:1,shortAbandons:1,withinTarget:2,completedHandled:4,talkSeconds:160,holdSeconds:40,wrapSeconds:40})
  assert.deepEqual(queue.serviceLevel,{numerator:2,denominator:5,value:0.4});assert.equal(queue.asaSeconds.value,17.5);assert.equal(queue.ahtSeconds.value,60)
  assert.deepEqual(queue.abandonment,{numerator:1,denominator:5,value:0.2});assert.equal(queue.averageAbandonSeconds.value,40)
  assert.deepEqual(queue.agents[handler].occupancy,{numerator:240,denominator:600,value:0.4})
  await f.write('/api/handset/metrics/config',{...config,method:'exclude-abandons'})
  assert.deepEqual((await live('queueId=queue-A')).serviceLevel,{numerator:2,denominator:4,value:0.5})
  await f.write('/api/handset/metrics/config',{...config,revision:2,shortSeconds:0})
  const zero=await live('queueId=queue-A');assert.equal(zero.serviceLevel.value,1/3);assert.equal(zero.abandonment.value,1/3);assert.equal(zero.averageAbandonSeconds.value,21.5)
  await f.write('/api/handset/metrics/config',metricConfig('queue-B',0,{startAt:callReportStart,endAt:callReportNow,repeatWindowHours:24}))
  const b=await live('queueId=queue-B')
  assert.deepEqual(b.native.sourceCalls.map(c=>c.id),calls.slice(0,3).map(c=>c.recordId));assert.deepEqual(b.callbackParents,[{id:dataset.entries[8].id,parentEntryId:dataset.entries[2].id,callId:calls[2].recordId}])
  assert.deepEqual([b.totals.offered,b.totals.transfers,b.totals.overflows,b.totals.callbacks,b.totals.arrivals],[2,1,1,1,0]);assert.equal((await live('queueId=queue-A')).totals.arrivals,6)
  const dashboard=await f.write('/api/handset/metrics/dashboards',{name:'Winter booking outcomes',queueId:'*',configRevision:1,filters:{trackingSource:'Winter repairs'},groups:['handlingUser','trackingSource'],metrics:['volume','contained','converted','serviceSeconds','handoffs','pendingWork']})
  const saved=await f.write('/api/handset/metrics/finalize',{queueId:'*',configRevision:1,dashboardId:dashboard.id,dashboardRevision:1})
  const csv=await (await runtime.request('/api/handset/metrics/dashboards/'+dashboard.id+'/csv',{headers})).text()
  assert.equal(csv.trim().split('\r\n').length,7);assert.ok(csv.includes(handler));assert.ok(csv.includes(calls[0].offerId));assert.ok(csv.includes('Winter repairs'));assert.ok(csv.includes(f.outcomes[0].id));assert.ok(!csv.includes(f.unlinked.id));assert.ok(csv.includes(f.crm.step.id));assert.ok(csv.includes(f.uncertain.step.id))
  const schedule={queueId:'*',configRevision:1,dashboardId:dashboard.id,dashboardRevision:1,recipient:runtime.ownerEmail,dueAt:callReportNow,confirm:'schedule this owner report'}
  await f.write('/api/handset/metrics/schedule',{...schedule,recipient:'synthetic-handset-restricted@example.test'},403)
  await f.write('/api/handset/metrics/schedule',schedule)
  const mailCount=runtime.mails.length;await runtime.scheduled();await runtime.scheduled();assert.equal(runtime.mails.length,mailCount+1)
  const mailed=JSON.parse(runtime.mails.at(-1).content.find(p=>p.type==='text/plain').value)
  for(const key of ['sourceCalls','byHandlingUser','byTrackingSource','containment','conversion','receptionist'])assert.deepEqual(mailed.native[key],n[key],'scheduled '+key)
  await f.write('/api/handset/metrics/groups',{number:'+15125550125',team:'Support',location:'Austin',trackingSource:'Unattributed',revision:1})
  const cleared=(await live()).native;assert.equal(cleared.conversion.value,null);assert.equal(cleared.conversion.excluded.unattributed,6)
  await runtime.restart();headers.cookie=(await signIn(runtime)).cookie
  const history=await (await runtime.request('/api/handset/metrics/history/'+saved.id,{headers})).json()
  assert.deepEqual(history.native.conversion,n.conversion);assert.deepEqual(history.native.byHandlingUser,n.byHandlingUser);assert.deepEqual(history.native.receptionist,n.receptionist)
  await post(runtime,'/auth/operator/status',{operatorId:'synthetic-handset-2',status:'active'},headers)
  const member=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  for(const path of ['live?queueId=*&handlingUser='+handler,'live?queueId=*&receptionistState=confirmed','csv?queueId=*&receptionistState=pending','dashboards/'+dashboard.id,'dashboards/'+dashboard.id+'/csv','history/'+saved.id])assert.equal((await runtime.request('/api/handset/metrics/'+path,{headers:{cookie:member.cookie}})).status,403)
 }finally{await runtime.close()}
})

test('Queued voicemail suppresses withdrawn authority and content and never repeats an uncertain external copy',async()=>{
 const {voicemailDeliveryFixture}=await import('./helpers/handset-voicemail-delivery.mjs'),f=await voicemailDeliveryFixture()
 try{
  const first=await f.item(10),setting=await f.settings(),job=await f.queue(first,setting),before=f.runtime.mails.length
  await f.membership(0);const reads=f.runtime.sourceRequests.length
  await f.runtime.restart();await f.runtime.scheduled();await f.runtime.scheduled()
  assert.equal(f.runtime.mails.length,before);assert.equal(f.runtime.sourceRequests.length,reads)
  assert.equal((await f.get(f.base+'/delivery')).jobs.find(j=>j.id===job.job.id).state,'suppressed')
  await f.membership(1)
  const second=await f.item(11),current=await f.settings(),during=await f.queue(second,current)
  f.runtime.twilioResources.set(second.mediaUrl,async()=>{await f.membership(0);return {__audio:[...second.bytes]}})
  await f.runtime.scheduled();assert.equal(f.runtime.mails.length,before,'membership lost during audio retrieval releases no email')
  assert.equal((await f.get(f.base+'/delivery')).jobs.find(j=>j.id===during.job.id).state,'suppressed')
  await f.membership(1)
  const third=await f.item(12),updated=await f.settings(),changed=await f.queue(third,updated)
  await f.settings('text');await f.runtime.scheduled();assert.equal(f.runtime.mails.length,before)
  assert.equal((await f.get(f.base+'/delivery')).jobs.find(j=>j.id===changed.job.id).state,'suppressed','queued choice never silently switches modes')
  const fourth=await f.item(13),approved=await f.settings(),revoked=await f.queue(fourth,approved)
  f.runtime.twilioResources.set(fourth.mediaUrl,async()=>{await f.write('/api/handset/recordings/grants/'+fourth.grant.id+'/revoke',{},f.owner,200);return {__audio:[...fourth.bytes]}})
  await f.runtime.scheduled();assert.equal(f.runtime.mails.length,before,'content grant lost during retrieval releases no email')
  assert.equal((await f.get(f.base+'/delivery')).jobs.find(j=>j.id===revoked.job.id).state,'suppressed')
  const fifth=await f.item(14),uncertain=await f.queue(fifth,approved)
  f.runtime.setMailFailure();await f.runtime.scheduled();assert.equal(f.runtime.mails.length,before+1)
  const outcome=(await f.get(f.base+'/delivery')).jobs.find(j=>j.id===uncertain.job.id);assert.equal(outcome.state,'uncertain')
  f.runtime.setMailFailure(false);await f.runtime.restart();await Promise.all([f.runtime.scheduled(),f.runtime.scheduled()])
  assert.equal(f.runtime.mails.length,before+1,'lost provider acknowledgement remains held across restart and replay')
  const missing=await f.item(15,{grantText:false})
  await f.queue(missing,approved,{},403)
  await f.write(missing.path+'/content',{recordingId:first.recordingId,transcriptId:first.transcriptId},f.owner,409)
  await f.write(f.base+'/delivery',{personId:f.personId,recipient:[f.personId,'example.test'].join('@'),personVersion:1,revision:approved.revision,mode:'text',enabled:1,linkSeconds:3600,confirm:'I approve this exact recipient and mode with separate email custody'},f.recipient,403)
  assert.equal(f.runtime.mails.length,before+1)
  const staleRecipient=await f.settings('text')
  await f.write(f.base+'/delivery',{personId:f.personId,recipient:['synthetic-handset-4999','example.test'].join('@'),personVersion:1,revision:staleRecipient.revision,mode:'text',enabled:1,linkSeconds:3600,confirm:'I approve this exact recipient and mode with separate email custody'},f.owner,409)
  const unavailable=await f.item(16),sourceJob=await f.queue(unavailable,staleRecipient)
  await f.write('/api/handset/sources/revoke',{sourceId:f.source.id},f.owner,200)
  const sourceReads=f.runtime.sourceRequests.length
  await f.runtime.scheduled();await f.runtime.restart();await f.runtime.scheduled()
  assert.equal(f.runtime.mails.length,before+1);assert.equal(f.runtime.sourceRequests.length,sourceReads)
  assert.equal((await f.get(f.base+'/delivery')).jobs.find(j=>j.id===sourceJob.job.id).state,'suppressed')
 }finally{await f.runtime.close()}
})
