import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { openHandset } from '../helpers/handset-worker.mjs'
import { createEdges } from '../helpers/handset-edges.mjs'
import { callReportsFixture,callReportStart,callReportNow } from '../helpers/handset-call-reports.mjs'
import { metricConfig } from '../helpers/handset-metrics.mjs'

assert.match(process.env.MAIL_TO??'',/^[^\s@]+@runeditrun\.com$/,'use only the approved fleet QA inbox')
assert.match(process.env.MAIL_FROM??'',/^[^\s@]+@mail\.runeditrun\.com$/,'use the authenticated RunEditRun sender domain')
assert.ok(process.env.MAIL_API_KEY&&process.env.MAILBOX_RECEIPT_URL,'use the held-key injector')
const candidate=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),since=Date.now()
const edges=createEdges(),runtime=await openHandset({twilio:true,edges,clockTime:callReportNow,liveMail:true})
try {
 const f=await callReportsFixture(runtime,edges)
 const config=await f.write('/api/handset/metrics/config',metricConfig('queue-A',0,{startAt:callReportStart,endAt:callReportNow,repeatWindowHours:24}))
 const schedule={queueId:'queue-A',configRevision:config.revision,recipient:runtime.ownerEmail,dueAt:callReportNow,confirm:'schedule this owner report'}
 await f.write('/api/handset/metrics/schedule',{...schedule,recipient:runtime.ownerEmail.replace('@','+restricted@')},403)
 const approved=await f.write('/api/handset/metrics/schedule',schedule)
 await runtime.scheduled()
 const submitted=runtime.mails.filter(m=>m.subject==='Handset queue report: queue-A')
 assert.equal(submitted.length,1,'one scheduled report was submitted')
 const sent=JSON.parse(submitted[0].content.find(part=>part.type==='text/plain').value)
 const snapshot=await runtime.request('/api/handset/metrics/history/'+sent.reportId,{headers:f.source.headers})
 assert.equal(snapshot.status,200)
 const {id,...history}=await snapshot.json()
 assert.deepEqual(sent,{reportId:id,...history},'the sent definition equals the permission-checked immutable snapshot')
 assert.deepEqual(sent.native.totals,{volume:6,answered:4,missed:2,unknown:0,legs:1})
 assert.deepEqual(sent.serviceLevel,{numerator:2,denominator:5,value:0.4})
 assert.deepEqual(sent.sourceEntryIds,f.dataset.entries.slice(0,6).map(entry=>entry.id))
 assert.deepEqual(sent.native.recovery.confirmedCaseIds,[f.calls[4].caseId])
 assert.equal(sent.config.timezone,'America/Chicago')
 const mailbox=new URL(process.env.MAILBOX_RECEIPT_URL)
 assert.equal(mailbox.protocol,'https:')
 mailbox.searchParams.set('to',runtime.ownerEmail);mailbox.searchParams.set('since',String(since));mailbox.searchParams.set('subject',submitted[0].subject)
 let delivered
 for(let attempt=0;attempt<45;attempt++) {
  const reply=await fetch(mailbox,{signal:AbortSignal.timeout(10000),redirect:'error'})
  assert.equal(reply.status,200,'controlled receipt mailbox is accessible')
  const result=await reply.json()
  delivered=result.receipts?.find(receipt=>String(receipt.excerpt??'').includes(sent.reportId))
  if(delivered)break
  await new Promise(resolve=>setTimeout(resolve,2000))
 }
 assert.ok(delivered,'the independent inbox received this exact report')
 assert.equal(delivered.auth?.dmarc,'pass','the independent receiver authenticated this sender')
 assert.ok(delivered.rawUrl,'full report receipt is available')
 const rawUrl=new URL(delivered.rawUrl,mailbox)
 assert.equal(rawUrl.origin,mailbox.origin,'receipt credentials stay at the approved inbox')
 assert.equal(rawUrl.pathname,'/receipts/'+delivered.id+'/raw')
 if(mailbox.searchParams.has('token'))rawUrl.searchParams.set('token',mailbox.searchParams.get('token'))
 const raw=await fetch(rawUrl,{signal:AbortSignal.timeout(10000),redirect:'error'})
 assert.equal(raw.status,200,'the independent raw MIME is readable')
 const text=execFileSync('python3',['-c',"import sys; from email import policy; from email.parser import BytesParser; message=BytesParser(policy=policy.default).parsebytes(sys.stdin.buffer.read()); body=message.get_body(preferencelist=('plain',)); assert body is not None; sys.stdout.write(body.get_content())"],{input:Buffer.from(await raw.arrayBuffer()),encoding:'utf8',maxBuffer:2*1024*1024})
 assert.deepEqual(JSON.parse(text),sent,'independently received full report reconciles every source call, formula, denominator and outcome')
 await runtime.scheduled()
 assert.equal(runtime.mails.filter(m=>m.subject==='Handset queue report: queue-A').length,1,'scheduler replay submits no second copy')
 const jobs=await (await runtime.request('/api/handset/metrics',{headers:f.source.headers})).json()
 assert.equal(jobs.schedules.find(job=>job.id===approved.id).state,'accepted')
 console.log(JSON.stringify({journey:'Independent scheduled analytics report receipt',candidate,scheduleId:approved.id,reportId:sent.reportId,receiptId:delivered.id,dmarc:delivered.auth.dmarc,calls:6,answered:4,missed:2,sourceEntries:6,serviceLevel:'2 of 5',confirmedRecoveryCases:1,timezone:sent.config.timezone,fullMimeReconciled:true,duplicateSubmissions:0}))
} finally {await runtime.close()}
