import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { exportFixture,range } from '../helpers/handset-exports.mjs'
import { post } from '../helpers/handset-auth.mjs'

assert.match(process.env.MAIL_TO??'',/^[^\s@]+@runeditrun\.com$/,'use only the approved fleet QA inbox')
assert.match(process.env.MAIL_FROM??'',/^[^\s@]+@mail\.runeditrun\.com$/,'use the checked RunEditRun authenticated sender domain')
assert.ok(process.env.MAIL_API_KEY&&process.env.MAILBOX_RECEIPT_URL,'use the held-key injector')
const candidate=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),f=await exportFixture(undefined,{liveMail:true})
try {
 const since=Date.now(),media=await f.media(81,{transcript:false})
 const response=await post(f.runtime,'/api/handset/queues',{name:'Cedar Creek service',mode:'longest_idle',skills:[],maxWaitSeconds:120,wrapSeconds:30,maxWaiting:100,overflowKind:'voicemail',confirm:'approve native queue policy'},f.headers)
 assert.equal(response.status,201);const queue=await response.json()
 const entry=await post(f.runtime,'/api/handset/queues/'+queue.id+'/entries',{callId:media.callId,language:'en',skills:[],priority:0},f.headers);assert.equal(entry.status,201)
 const schedule=await f.write('/schedules',{...range,queueId:queue.id,recipient:f.runtime.ownerEmail,dueAt:Date.now(),emailCopyPolicy:'I approve sensitive call-log CSV copies to this exact recipient in separate email custody',confirm:'schedule this exact call-log email'})
 console.log(JSON.stringify({journey:'Reviewed fleet QA call-log schedule',candidate,exportId:schedule.id}))
 await f.runtime.scheduled()
 const sent=f.runtime.mails.filter(m=>m.subject?.startsWith('Handset call-log CSV'))
 assert.equal(sent.length,1,'one scheduled email was submitted')
 const csv=Buffer.from(sent[0].attachments[0].content,'base64').toString('utf8')
 assert.ok(csv.includes(media.callId));assert.ok(csv.includes(range.timezone))
 const url=new URL(process.env.MAILBOX_RECEIPT_URL)
 url.searchParams.set('to',f.runtime.ownerEmail);url.searchParams.set('since',String(since));url.searchParams.set('subject',sent[0].subject)
 let delivered
 for(let attempt=0;attempt<45;attempt++) {
  const reply=await fetch(url);assert.equal(reply.status,200,'controlled receipt mailbox is accessible')
  const result=await reply.json()
  delivered=result.receipts?.find(r=>String(r.excerpt??'').includes(schedule.id))
  if(delivered)break
  await new Promise(resolve=>setTimeout(resolve,2000))
 }
 assert.ok(delivered,'the controlled inbox received this exact call-log schedule')
 assert.equal(delivered.auth?.dmarc,'pass','the controlled receiver authenticates the sender')
 assert.ok(delivered.excerpt.includes('Calls: 1'));assert.ok(delivered.excerpt.includes('Legs: 0'));assert.ok(delivered.excerpt.includes(range.timezone))
 await f.runtime.scheduled();assert.equal(f.runtime.mails.filter(m=>m.subject?.startsWith('Handset call-log CSV')).length,1)
 console.log(JSON.stringify({journey:'Delivered fleet QA call-log CSV schedule',candidate,exportId:schedule.id,receiptId:delivered.id,dmarc:delivered.auth.dmarc,calls:1,legs:0,timezone:range.timezone,scheduler:'Worker scheduled event',duplicateSubmissions:0}))
} finally {await f.runtime.close()}
