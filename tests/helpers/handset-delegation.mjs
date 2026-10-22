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
