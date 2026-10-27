import assert from 'node:assert/strict'
import { openHandset } from './handset-worker.mjs'
import { sourceFixture } from './handset-sources.mjs'
import { post, signIn } from './handset-auth.mjs'

export const captureParticipants=[{id:'synthetic-handset-101',consent:'yes'},{id:'synthetic-handset-102',consent:'yes'}]
export async function captureFixture(){
 const runtime=await openHandset({twilio:true,clockTime:Date.parse('2026-10-27T18:00:00Z')})
 try{
  const f=await sourceFixture(runtime),callSid='synthetic-handset-110',recordingSid='synthetic-handset-111',base='/api/handset/recordings/capture',requests=[]
  const call=await f.callback({CallSid:callSid,CallStatus:'in-progress',SequenceNumber:'0',Timestamp:new Date().toUTCString()})
  assert.equal(call.status,200,await call.clone().text());const callId=(await call.json()).recordId
  f.resource('Calls',callSid,{status:'in-progress',from:'+15125550126',to:'+15125550125'})
  const url=`https://api.twilio.com/2010-04-01/Accounts/${f.account}/Calls/${callSid}/Recordings`
  function command(request){return request.text().then(raw=>{const body=Object.fromEntries(new URLSearchParams(raw));requests.push({method:request.method,url:request.url,body});return {sid:recordingSid,account_sid:f.account,call_sid:callSid,status:body.Status??'in-progress'}})}
  runtime.twilioResources.set(url+'.json',command)
  runtime.twilioResources.set(url+'/'+recordingSid+'.json',command)
  f.resource('Recordings',recordingSid,{call_sid:callSid,status:'completed',start_time:new Date().toUTCString(),duration:'120',channels:2})
  const result={...f,runtime,callId,callSid,recordingSid,base,requests,session:null,
   async create(overrides={}){const r=await post(runtime,base,{callId,jurisdiction:'all-party',participants:captureParticipants,confirm:'review exact call participants',...overrides},f.headers);assert.equal(r.status,201,await r.clone().text());result.session=(await r.json()).session;return result.session},
   async get(){const r=await runtime.request(base+'/'+result.session.id,{headers:f.headers});assert.equal(r.status,200,await r.clone().text());result.session=(await r.json()).session;return result.session},
   async act(action,body={},status=200){await result.get();const response=await post(runtime,base+'/'+result.session.id+'/'+action,{revision:result.session.revision,...body},f.headers);assert.equal(response.status,status,await response.clone().text());const value=await response.json();if(value.session)result.session=value.session;return value},
   async completeRecording(){if(['capturing','paused'].includes((await result.get()).state))await result.act('stop');const r=await f.callback({RecordingSid:recordingSid,CallSid:callSid,RecordingStatus:'completed',From:'',To:''});assert.equal(r.status,200,await r.clone().text());return (await r.json()).recordId},
   async member(){assert.equal((await post(runtime,'/auth/operator/status',{operatorId:'synthetic-handset-2',status:'active'},f.headers)).status,200);return signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})},
  }
  return result
 }catch(error){await runtime.close();throw error}
}
export const announceCapture=f=>f.act('announcement',{confirm:'I heard the announcement finish for these exact participants'})
export const startCapture=async f=>{await announceCapture(f);return f.act('start',{confirm:'start this consented recording'})}

export async function captureArchive(f){
 const {createHash}=await import('node:crypto'),base='/api/handset/exports'
 const key=createHash('sha256').update('synthetic-handset-120').digest('hex')
 const connector=await post(f.runtime,base+'/connectors',{provider:'sftp',destination:{folder:'/archive',host:'synthetic-handset-archive.example.test',port:22,user:'buyer',hostKey:'SHA256:'+createHash('sha256').update('synthetic-handset-121').digest('base64').replace(/=+$/,'')},retentionDays:30,confirm:'approve scoped destination and separate external custody'},f.headers)
 assert.equal(connector.status,201,await connector.clone().text())
 const planned=await post(f.runtime,base+'/jobs',{connectorId:(await connector.json()).id,encryptionKey:key,from:Date.parse('2026-10-27T00:00:00Z'),to:Date.parse('2026-10-28T00:00:00Z'),timezone:'America/Chicago',confirm:'prepare this exact recording archive'},f.headers)
 assert.equal(planned.status,201,await planned.clone().text());const job=await planned.json()
 assert.equal((await post(f.runtime,base+'/jobs/'+job.id+'/approve',{previewHash:job.previewHash,confirm:'approve exact archive and separate external custody'},f.headers)).status,200)
 return {job,download:recordingId=>post(f.runtime,base+'/jobs/'+job.id+'/files/audio-'+recordingId,{encryptionKey:key},f.headers)}
}
