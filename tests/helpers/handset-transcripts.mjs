import assert from 'node:assert/strict'
import { openHandset } from './handset-worker.mjs'
import { sourceFixture } from './handset-sources.mjs'
import { post } from './handset-auth.mjs'

export async function transcriptFixture(){
 const runtime=await openHandset({twilio:true})
 try{
  const f=await sourceFixture(runtime),base='/api/handset/transcripts'
  async function write(path,value,status=201,headers=f.headers){const r=await post(runtime,base+path,value,headers);assert.equal(r.status,status,await r.clone().text());return r.json()}
  async function get(path='',headers=f.headers){const r=await runtime.request(base+path,{headers});assert.equal(r.status,200,await r.clone().text());return r.json()}
  async function create(day=0,state='supplied'){
   const callSid=`synthetic-handset-${810+day}`,sid=`synthetic-handset-${830+day}`,date=new Date(Date.parse('2026-10-19T16:00:00Z')+day*86400000).toUTCString()
   const call=await f.callback({CallSid:callSid,CallStatus:'completed',SequenceNumber:'0',Timestamp:date});assert.equal(call.status,200,await call.clone().text())
   f.resource('Recordings',sid,{call_sid:callSid,start_time:date,status:'completed',duration:'120',channels:2})
   const recording=await f.callback({RecordingSid:sid,CallSid:callSid,RecordingStatus:'completed',From:'',To:''});assert.equal(recording.status,200,await recording.clone().text())
   const recordingId=(await recording.json()).recordId
   const input={recordingId,durationMs:120000,state,confirm:'authorize supplied transcript for my exact identity',...(state==='supplied'?{segments:[{id:'synthetic-handset-850',speaker:'Maria Torres',language:'en',startMs:32000,endMs:37000,text:'I will call about the refund on Tuesday. Check the condensor.',confidence:0.96},{id:'synthetic-handset-851',speaker:'Rosa García',language:'es',startMs:45000,endMs:50000,text:'El condensor no funciona; necesito el reembolso.',confidence:0.65}]}:{reason:'Audio unavailable from the speech processor'})}
   return {...await write('',input),input,recordingId}
  }
  return {...f,runtime,base,write,get,create}
 }catch(error){await runtime.close();throw error}
}
