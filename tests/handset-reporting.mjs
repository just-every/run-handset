import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'
import { metricDataset,metricConfig } from './helpers/handset-metrics.mjs'
import { exportFixture, archiveEdge, sftpEdge, range, encryptionKey, sha } from './helpers/handset-exports.mjs'
import { runSftp } from '../src/handset/exports/sftp.mjs'
import { analyticsFixture,analyticsStart,analyticsEnd,analyticsNow } from './helpers/handset-analytics.mjs'
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


test('Known-week customer reports reconcile canonical calls, missed DST hours, case owners, recovery outcomes, CSV and one owner-only scheduled snapshot',async()=>{
 const runtime=await openHandset({twilio:true,clockTime:analyticsNow})
 try{
  const {source,calls,recoveries}=await analyticsFixture(runtime),headers=source.headers
  const configured=await post(runtime,'/api/handset/metrics/config',metricConfig('*',0,{startAt:analyticsStart,endAt:analyticsEnd}),headers);assert.equal(configured.status,201,await configured.clone().text());const config=await configured.json()
  const response=await runtime.request('/api/handset/metrics/live?queueId=*',{headers});assert.equal(response.status,200);const report=await response.json(),n=report.native
  assert.deepEqual(n.totals,{volume:6,answered:1,missed:5,unknown:0,legs:1})
  assert.deepEqual(n.sourceCalls.map(c=>c.id),calls.slice(0,6).map(c=>c.recordId))
  assert.deepEqual(n.byPerson,[{label:'synthetic-handset-1',volume:6,answered:1,missed:5,sourceCallIds:calls.slice(0,6).map(c=>c.recordId)}])
  assert.deepEqual(n.byHour.map(h=>[h.volume,h.missed]),[[1,1],[1,1],[1,0],[1,1],[1,1],[1,1]])
  assert.match(n.byHour[0].label,/01.*GMT-05:00/);assert.match(n.byHour[1].label,/01.*GMT-06:00/)
  assert.deepEqual(n.byNumber.map(r=>[r.label,r.volume,r.missed]),[['+15125550125',6,5]])
  assert.equal(n.recovery.cases,2);assert.equal(n.recovery.confirmed,0);assert.deepEqual(n.recovery.confirmedCaseIds,[])
  assert.deepEqual(new Set(n.recovery.caseIds),new Set(recoveries.map(r=>r.case_id)))
  assert.deepEqual([n.fcr.numerator,n.fcr.denominator,n.fcr.value],[0,2,0]);assert.deepEqual(n.fcr.eligibleCallIds,calls.slice(0,2).map(c=>c.recordId));assert.deepEqual(n.fcr.repeatCallIds,[calls[0].recordId]);assert.deepEqual(n.fcr.excluded,{immature:3,unknownIdentity:0,repeatContact:1})
  assert.equal(n.csat.responseRate,null);assert.equal(n.csat.mean,null)
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
  await post(runtime,'/api/handset/metrics/config',metricConfig('synthetic-handset-foreign',0,{startAt:analyticsStart,endAt:analyticsEnd}),headers)
  assert.equal((await (await runtime.request('/api/handset/metrics/live?queueId=synthetic-handset-foreign',{headers})).json()).native.totals.volume,0)
  assert.equal((await runtime.request('/api/handset/metrics/csv?queueId=*')).status,401)
  await post(runtime,'/auth/operator/status',{operatorId:'synthetic-handset-2',status:'active'},headers)
  const member=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  for(const path of ['/api/handset/metrics/live?queueId=*','/api/handset/metrics/csv?queueId=*','/app/reports/queues/live?queueId=*'])assert.equal((await runtime.request(path,{headers:{cookie:member.cookie}})).status,403)
 }finally{await runtime.close()}
})
