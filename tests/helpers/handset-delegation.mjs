import assert from 'node:assert/strict'
import { post, signIn } from './handset-auth.mjs'
import { sourceFixture } from './handset-sources.mjs'
export async function delegationFixture(runtime){
 const f=await sourceFixture(runtime)
 await runtime.sql("UPDATE oa_operators SET status='active' WHERE id='synthetic-handset-2'")
 await runtime.sql("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES (?,?,?,?,?,?)",'synthetic-handset-700','synthetic-handset-700@example.test','Elena Rivera / Directora','member','active',Date.now())
 const assistant=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'}),principal=await signIn({...runtime,ownerEmail:'synthetic-handset-700@example.test'})
 async function create(path,value,headers=f.headers){const r=await post(runtime,'/api/handset/'+path,value,headers);assert.ok(r.ok,await r.clone().text());return r.json()}
 const lineInput={principalId:'synthetic-handset-700',numberId:f.numberId,sourceId:f.source.id,timezone:'UTC',opens:'00:00',closes:'23:59',weekdays:[0,1,2,3,4,5,6],dnd:0,confirm:'approve exact executive line policy'}
 const line=await create('front-desk/lines',lineInput)
 const grantInput={lineId:line.id,assistantId:'synthetic-handset-2',expiresAt:Date.now()+3600000,confirm:'approve exact assistant and executive line'}
 const grant=await create('front-desk/delegations',grantInput)
 const root={CallSid:'synthetic-handset-701',CallStatus:'ringing',SequenceNumber:'0',Timestamp:new Date().toUTCString()}
 const call=await f.callback(root);assert.equal(call.status,200,await call.clone().text());const callId=(await call.json()).recordId
 const operation={delegationId:grant.id,kind:'pickup',callId,lineRevision:1,idempotencyKey:'synthetic-handset-702'}
 return {...f,create,line,lineInput,grant,grantInput,root,callId,assistant,principal,operation,assistantHeaders:{cookie:assistant.cookie}}
}
export async function recordingFixture(runtime,f){
 const sid='synthetic-handset-710'
 f.resource('Recordings',sid,{call_sid:f.root.CallSid,start_time:new Date().toUTCString(),status:'completed'})
 const recorded=await f.callback({RecordingSid:sid,CallSid:f.root.CallSid,RecordingStatus:'completed',From:'',To:''})
 assert.equal(recorded.status,200,await recorded.clone().text());const recordingId=(await recorded.json()).recordId
 const url=`https://api.twilio.com/2010-04-01/Accounts/${f.account}/Recordings/${sid}.wav`
 // A short synthetic PCM WAV. Never includes captured voices or customer audio.
 const bytes=Buffer.alloc(60);bytes.write('RIFF');bytes.writeUInt32LE(52,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(16,40)
 runtime.twilioResources.set(url,{__audio:[...bytes]})
 const grantInput={recordingId,personId:'synthetic-handset-2',expiresAt:Date.now()+1800000,confirm:'approve consented recording for this exact person'}
 return {recordingId,url,bytes,grantInput,meta:`https://api.twilio.com/2010-04-01/Accounts/${f.account}/Recordings/${sid}.json`}
}

export async function controlFixture(runtime){
 const {dialerFixture}=await import('./handset-dialer.mjs'),{createHmac}=await import('node:crypto')
 const f=await dialerFixture(runtime)
 await runtime.sql("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES (?,?,?,?,?,?)",'synthetic-handset-740','synthetic-handset-740@example.test','Elena Rivera / Executive','member','active',Date.now())
 const assistant=await signIn({...runtime,ownerEmail:f.q.spanish+'@example.test'}),assistantHeaders={cookie:assistant.cookie},base='/api/handset/front-desk'
 const line=await f.write(base+'/lines',{principalId:'synthetic-handset-740',numberId:f.numberId,sourceId:f.source.id,timezone:'UTC',opens:'00:00',closes:'23:59',weekdays:[0,1,2,3,4,5,6],dnd:0,confirm:'approve exact executive line policy'},201)
 const grant=await f.write(base+'/delegations',{lineId:line.id,assistantId:f.q.spanish,expiresAt:Date.now()+3600000,confirm:'approve exact assistant and executive line'},201)
 const incoming='synthetic-handset-741',call={account_sid:f.account,sid:incoming,from:'+15125550126',to:'+15125550125',direction:'inbound',status:'in-progress',date_created:new Date().toUTCString(),start_time:new Date().toUTCString(),duration:null,end_time:null}
 const fields={AccountSid:f.account,CallSid:incoming,From:call.from,To:call.to,CallStatus:'in-progress',SequenceNumber:'0',Timestamp:new Date().toUTCString()}
 let signed=runtime.origin+'/providers/twilio/events';for(const key of Object.keys(fields).sort())signed+=key+fields[key]
 const source=await runtime.request('/providers/twilio/events',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':createHmac('sha1','synthetic-handset-500').update(signed).digest('base64')},body:new URLSearchParams(fields).toString()});assert.equal(source.status,200,await source.clone().text());const callId=(await source.json()).recordId
 let updates=0
 const callUrl=`https://api.twilio.com/2010-04-01/Accounts/${f.account}/Calls/${incoming}.json`
 runtime.twilioResources.set(callUrl,async request=>{
  if(request.method==='POST'){
   updates++;const params=await request.formData(),xml=params.get('Twiml')
   assert.match(xml,/<Conference /);assert.ok(!xml.includes('<Number')&&!xml.includes('<Sip')&&!xml.includes('<Client'));assert.ok(xml.includes('do-not-record'))
   const name=xml.match(/waitUrl="">([^<]+)<\/Conference>/)[1]
   const existing=(await runtime.sql('SELECT snapshot FROM hnd_frontdesk_controls ORDER BY rowid DESC LIMIT 1')).results[0],snapshot=JSON.parse(existing.snapshot),sid=snapshot.conferenceSid??'synthetic-handset-742'
   const member={account_sid:f.account,conference_sid:sid,call_sid:incoming,status:'connected',muted:false,hold:false}
   const members=[member,...(snapshot.agentCallSid?[{...member,call_sid:snapshot.agentCallSid}]:[])]
   runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${f.account}/Conferences.json?FriendlyName=${encodeURIComponent(name)}&Status=in-progress&PageSize=100`,{conferences:[{sid,account_sid:f.account,friendly_name:name,status:'in-progress'}],next_page_uri:null})
   runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${f.account}/Conferences/${sid}/Participants.json?PageSize=100`,{participants:members,next_page_uri:null})
  }
  return call
 })
 async function request(kind,target){const response=await post(runtime,base+'/operations',{delegationId:grant.id,kind,callId,lineRevision:1,idempotencyKey:f.next(),...(target?{target}:{})},assistantHeaders);assert.equal(response.status,202,await response.clone().text());return (await response.json()).operation}
 async function approve(op,listId){return f.write(base+'/approve',{operationId:op.id,maxSeconds:300,expiresAt:Date.now()+240000,...(listId?{listId}:{}),confirm:'approve this exact existing call move or single callback'})}
 async function execute(op){return post(runtime,base+'/execute',{operationId:op.id,confirm:'execute exact approved call request'},assistantHeaders)}
 async function reconcile(op){const r=await post(runtime,base+'/reconcile',{operationId:op.id},assistantHeaders);assert.equal(r.status,200,await r.clone().text());return r.json()}
 return {...f,assistant,assistantHeaders,line,grant,callId,callUrl,call,base,request,approve,execute,reconcile,get updates(){return updates}}
}
