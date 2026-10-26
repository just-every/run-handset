import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { openHandset } from './handset-worker.mjs'
import { sourceFixture } from './handset-sources.mjs'
import { post } from './handset-auth.mjs'

export const consentTime=Date.parse('2026-10-26T18:00:00Z')
export async function consentFixture() {
 const runtime=await openHandset({twilio:true,clockTime:consentTime})
 try {
  const source=await sourceFixture(runtime,{e164:'+18335550125'}),base='/api/handset/consent',business='+18335550125',staff='+15125551099'
  async function write(path,value,status=201) { const r=await post(runtime,path,value,source.headers);assert.equal(r.status,status,await r.clone().text());return r.json() }
  async function get(path=base) { const r=await runtime.request(path,{headers:source.headers});assert.equal(r.status,200,await r.clone().text());return r.json() }
  const configured=await write(base+'/policies',{sourceId:source.source.id,businessName:'Cedar Creek Heating',legalConfiguration:'Owner reviewed informational customer-care and separately requested feedback; explicit permission only, one reply per purpose, no marketing. TCPA review retained by Mara Patel.',registrationId:'synthetic-handset-903',staffTarget:staff,expiresAt:Date.now()+3600000,confirm:'approve exact informational consent policy'})
  const registration={sid:'synthetic-handset-903',account_sid:source.account,tollfree_phone_number:business,status:'TWILIO_APPROVED'}
  runtime.twilioResources.set('https://messaging.twilio.com/v1/Tollfree/Verifications/synthetic-handset-903',registration)
  const receiver={sent:[],drop:false}
  runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${source.account}/Messages.json`,async request=>{
   assert.equal(request.method,'POST');const form=Object.fromEntries(new URLSearchParams(await request.text()))
   assert.equal(form.From,business);assert.match(form.To,/^\+[1-9]\d{7,14}$/)
   const sid=`synthetic-handset-920-${receiver.sent.length+1}`,message={sid,account_sid:source.account,from:form.From,to:form.To,body:form.Body,direction:'outbound-api',status:'queued',date_created:new Date().toUTCString()}
   receiver.sent.push({form,message});source.resource('Messages',sid,message)
   if(receiver.drop){receiver.drop=false;throw new Error('synthetic-handset-lost-response')}
   return {...message,__httpStatus:201}
  })
  async function signed(path,fields,{signature=true}={}) {
   const data={AccountSid:source.account,...fields},p=new URLSearchParams(data)
   let payload=runtime.origin+path;for(const key of Object.keys(data).sort())payload+=key+data[key]
   return runtime.request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...(signature?{'x-twilio-signature':createHmac('sha1','synthetic-handset-500').update(payload).digest('base64')}:{})},body:p.toString()})
  }
  async function recipient(caller,timezone='America/Chicago') { return write(base+'/recipients',{recipient:caller,timezone,startMinute:480,endMinute:1260,expiresAt:Date.now()+3600000,confirm:'approve recipient timezone and hours'}) }
  async function start(n,{identity='TN-Validation-Passed',configureRecipient=true}={}) {
   const sid=`synthetic-handset-call-${n}`,caller=`+1512555${String(1000+n).padStart(4,'0')}`
   const fields={CallSid:sid,From:caller,To:business,CallStatus:'in-progress',Direction:'inbound',StirVerstat:identity}
   source.resource('Calls',sid,{from:caller,to:business,direction:'inbound',status:'in-progress',date_created:new Date().toUTCString(),start_time:new Date().toUTCString(),parent_call_sid:null})
   const received=await source.callback({CallSid:sid,From:caller,CallStatus:'in-progress',SequenceNumber:'0',Timestamp:new Date().toISOString()})
   assert.equal(received.status,200,await received.clone().text());const canonical=await received.json()
   if(configureRecipient)await recipient(caller)
   const response=await signed(configured.providerPath,fields);assert.equal(response.status,200,await response.clone().text())
   const prompt=await response.text(),call=(await get()).calls.find(c=>c.call_sid===sid)
   const decision=async digits=>{const r=await signed(`/providers/twilio/consent/calls/${call.id}/decision`,{...fields,...(digits!==null?{Digits:digits}:{})});assert.equal(r.status,200,await r.clone().text());return r.text()}
   const missed=async()=>{
    const legSid=`synthetic-handset-leg-${n}`
    source.resource('Calls',legSid,{parent_call_sid:sid,from:business,to:staff,direction:'outbound-dial',status:'no-answer',end_time:new Date().toUTCString()})
    const r=await signed(`/providers/twilio/consent/calls/${call.id}/outcome`,{...fields,DialCallSid:legSid,DialCallStatus:'no-answer'})
    assert.equal(r.status,200,await r.clone().text());return r.text()
   }
   return {sid,caller,fields,call,canonical,prompt,decision,missed}
  }
  async function stop(call) { const r=await source.callback({MessageSid:'synthetic-handset-stop-'+call.sid,From:call.caller,MessageStatus:'received',Body:'STOP',Timestamp:new Date().toISOString()});assert.equal(r.status,200,await r.clone().text()) }
  async function delivered(index=receiver.sent.length-1) { const m=receiver.sent[index];m.message.status='delivered';source.resource('Messages',m.message.sid,m.message);const r=await signed(new URL(m.form.StatusCallback).pathname,{MessageSid:m.message.sid,MessageStatus:'delivered',From:business,To:m.message.to});assert.equal(r.status,200,await r.clone().text());return r.json() }
  async function finishStaff(call) {
   const legSid='synthetic-handset-completed-'+call.sid
   source.resource('Calls',legSid,{parent_call_sid:call.sid,from:business,to:staff,direction:'outbound-dial',status:'completed',duration:'20',end_time:new Date().toUTCString()})
   const r=await signed(`/providers/twilio/consent/calls/${call.call.id}/outcome`,{...call.fields,DialCallSid:legSid,DialCallStatus:'completed'})
   assert.equal(r.status,200,await r.clone().text());return r.text()
  }
  return {runtime,source,base,business,staff,configured,registration,receiver,write,get,signed,recipient,start,stop,delivered,finishStaff}
 } catch(error) { await runtime.close();throw error }
}
export async function oneReplyJourney(f) {
 const call=await f.start(1)
 assert.match(call.prompt,/Cedar Creek Heating/);assert.match(call.prompt,/input="dtmf"/);assert.match(call.prompt,/Press 1/)
 const ringing=await call.decision('1');assert.match(ringing,new RegExp(f.staff.replace('+','\\+')))
 const began=performance.now();await call.missed();let elapsed=performance.now()-began
 assert.equal(f.receiver.sent.length,1);assert.ok(elapsed<60000)
 let report=await f.get(),permission=report.permissions.find(p=>p.call_id===call.call.id)
 const event=JSON.parse(permission.event)
 assert.equal(event.caller,call.caller);assert.equal(event.business,f.business);assert.equal(event.callSid,call.sid);assert.equal(event.legSid,call.sid)
 assert.equal(event.kind,'dtmf');assert.equal(event.digits,'1');assert.equal(event.purpose,'one_reply');assert.equal(event.promptVersion,f.configured.policy.id)
 assert.equal(event.serverTimestamp,consentTime);assert.match(event.legalBasis,/explicit caller permission/);assert.match(event.legalConfiguration,/TCPA/)
 assert.equal(event.marketingEnrollment,false);assert.equal(permission.state,'consumed');assert.equal(report.outcomes.length,1)
 assert.equal(report.texts[0].state,'confirmed');assert.equal(report.texts[0].delivered_at,null,'accepted is not delivered')
 await f.delivered();elapsed=performance.now()-began;assert.ok(elapsed<60000,'independent delivery edge receipt stays within the deadline');await call.decision('1');await call.missed();await f.runtime.restart();await call.missed();await f.runtime.scheduled()
 assert.equal(f.receiver.sent.length,1);report=await f.get();assert.equal(report.outcomes.length,1);assert.equal(report.permissions.length,1)
 return {call,elapsed}
}

export async function surveyJourney(f) {
 const calls=[]
 for(let n=40;n<50;n++)calls.push(await f.start(n))
 const operators=await f.get('/auth/operators'),casesBefore=await f.get('/api/handset/cases')
 const sentimentSid='synthetic-handset-survey-sentiment'
 f.source.resource('Recordings',sentimentSid,{call_sid:calls[7].sid,start_time:new Date().toUTCString(),status:'completed',duration:'20',channels:2})
 const audio=await f.source.callback({RecordingSid:sentimentSid,CallSid:calls[7].sid,RecordingStatus:'completed',From:'',To:''});assert.equal(audio.status,200)
 const supplied=await f.write('/api/handset/transcripts',{recordingId:(await audio.json()).recordId,durationMs:20000,state:'supplied',segments:[{id:'synthetic-handset-sentiment-moment',speaker:'Caller',language:'en',startMs:1000,endMs:2000,text:'The furnace works now.',confidence:1}],confirm:'authorize supplied transcript for my exact identity'})
 await f.write('/api/handset/transcripts/'+supplied.transcriptId+'/annotations',{segmentId:'synthetic-handset-sentiment-moment',kind:'sentiment',text:'Inferred positive sentiment; predicted satisfaction 5. This is not a customer rating.'})
 async function invite(call,channel) {return f.write('/api/handset/surveys',{callRecordId:call.canonical.recordId,channel,confirm:'approve this post-call survey'})}
 async function voice(invite,call,action='',digits) {const r=await f.signed(invite.providerPath+action,{...call.fields,...(digits?{Digits:digits}:{})});assert.equal(r.status,200,await r.clone().text());return r.text()}
 const ivr=await invite(calls[0],'ivr'),sms=await invite(calls[1],'sms'),declined=await invite(calls[2],'ivr'),stopped=await invite(calls[3],'sms'),silent=await invite(calls[4],'ivr')
 await calls[0].decision('1')
 for(const call of calls){if(call!==calls[0])await call.decision('2');const end=await f.finishStaff(call);if(call===calls[0])assert.match(end,/surveys\//)}
 let state=await f.get('/api/handset/surveys');assert.equal(state.denominators.responses,0)
 assert.equal((await f.get()).permissions.find(p=>p.call_id===calls[0].call.id).purpose,'one_reply','care permission grants no survey')
 assert.match(await voice(ivr,calls[0]),/optional feedback/);assert.match(await voice(ivr,calls[0],'/consent','1'),/rate your experience from 1 to 5/)
 await voice(ivr,calls[0],'/rating','2');await voice(ivr,calls[0],'/rating','5')
 await voice(sms,calls[1]);await voice(sms,calls[1],'/consent','1')
 await voice(declined,calls[2],'/consent','2');await voice(stopped,calls[3],'/consent','1');await f.stop(calls[3])
 await voice(silent,calls[4],'/consent','1')
 await f.runtime.scheduled();assert.equal(f.receiver.sent.length,1)
 state=await f.get('/api/handset/surveys');assert.equal(state.denominators.eligibleDelivered,2,'accepted SMS has no delivery eligibility');assert.equal(state.denominators.responses,1)
 await f.delivered();await f.runtime.scheduled()
 const replySid='synthetic-handset-survey-reply',body='5 Very helpful, thank you'
 f.source.resource('Messages',replySid,{from:calls[1].caller,to:f.business,body,direction:'inbound',status:'received',date_created:new Date().toUTCString()})
 for(let n=0;n<2;n++) { const r=await f.source.callback({MessageSid:replySid,From:calls[1].caller,To:f.business,Body:body,MessageStatus:'received',Timestamp:new Date().toISOString()});assert.equal(r.status,200,await r.clone().text()) }
 state=await f.get('/api/handset/surveys')
 assert.equal(state.denominators.invitations,5);assert.equal(state.denominators.eligibleDelivered,3);assert.equal(state.denominators.responses,2);assert.equal(state.denominators.averageRating,3.5);assert.equal(state.denominators.responseRate,2/3);assert.equal(state.denominators.declined,1);assert.equal(state.denominators.suppressed,1)
 assert.equal(state.invitations.find(i=>i.id===ivr.invitation.id).rating,2);assert.equal(state.invitations.find(i=>i.id===sms.invitation.id).comment,'Very helpful, thank you')
 assert.deepEqual(await f.get('/auth/operators'),operators,'surveys do not change staff status');assert.deepEqual(await f.get('/api/handset/cases'),casesBefore,'surveys do not close or change call cases')
 for(const call of calls) {const r=await f.source.callback({CallSid:call.sid,From:call.caller,CallStatus:'completed',SequenceNumber:'1',Timestamp:new Date().toISOString()});assert.equal(r.status,200,await r.clone().text())}
 const care=await f.get();assert.equal(care.calls.length,10);assert.equal(care.outcomes.length,0,'surveys did not invent a missed outcome');assert.ok(care.permissions.every(p=>JSON.parse(p.event).marketingEnrollment===false))
 return {calls,ivr,sms,declined,stopped,silent,state}
}
