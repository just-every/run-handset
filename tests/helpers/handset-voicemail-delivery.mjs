import assert from 'node:assert/strict'
import { exportFixture } from './handset-exports.mjs'
import { post } from './handset-auth.mjs'
import { openHandset } from './handset-worker.mjs'

export async function voicemailDeliveryFixture(existingRuntime,{clockTime}={}){
 const runtime=existingRuntime??await openHandset({twilio:true,clockTime})
 const f=await exportFixture(undefined,{runtime}),owner=f.headers,personId='synthetic-handset-4100'
 const recipient=await f.persona(personId)
 const write=async(path,value,headers=owner,status=201)=>{const r=await post(runtime,path,value,headers);assert.equal(r.status,status,await r.clone().text());return r.json()}
 const get=async(path,headers=owner,status=200)=>{const r=await runtime.request(path,{headers});assert.equal(r.status,status,await r.clone().text());return r.json()}
 const box=(await write('/api/handset/voicemail/boxes',{name:'Reviewed voicemail delivery',kind:'shared'})).box
 const base='/api/handset/voicemail/boxes/'+box.id
 const membership=async(enabled)=>{
  const current=await get(base)
  return write(base+'/members',{revision:current.box.revision,personId,enabled,allowWork:0},owner,200)
 }
 await membership(1)
 const item=async(index=1,{grantMedia=true,grantText=true}={})=>{
  const media=await f.media(4100+index)
  // A valid mono PCM WAV, independently playable by the browser media element.
  const bytes=Buffer.alloc(44+16000)
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(16000,40)
  for(let i=0;i<8000;i++)bytes.writeInt16LE(Math.round(2000*Math.sin(i*2*Math.PI*440/8000)),44+i*2)
  const mediaUrl='https://api.twilio.com/2010-04-01/Accounts/'+f.account+'/Recordings/synthetic-handset-'+(3100+4100+index)+'.wav'
  runtime.twilioResources.set(mediaUrl,{__audio:[...bytes]})
  const grant=grantMedia?await write('/api/handset/recordings/grants',{recordingId:media.recordingId,personId,expiresAt:Date.now()+3500000,confirm:'approve consented recording for this exact person'}):null
  if(grantText)await write('/api/handset/transcripts/'+media.transcriptId+'/grants',{personId,expiresAt:Date.now()+3500000,confirm:'approve this exact person to read transcript text'})
  const observation=(await write(base+'/observations',{sourceId:media.recordingId,text:'Supplied voicemail reference; no capture qualification.',language:'en'})).item
  const path=base+'/items/'+observation.id
  await write(path+'/content',{recordingId:media.recordingId,transcriptId:media.transcriptId})
  return {...media,bytes,mediaUrl,grant,item:observation,path}
 }
 const settings=async(mode='attachment_text',extra={})=>{
  const view=await get(base+'/delivery'),old=view.settings.find(s=>s.person_id===personId)
  return write(base+'/delivery',{personId,recipient:[personId,'example.test'].join('@'),personVersion:1,revision:old?.revision??0,mode,enabled:1,linkSeconds:3600,confirm:'I approve this exact recipient and mode with separate email custody',...extra})
 }
 const queue=(media,setting,extra={},status=201)=>write(media.path+'/deliver',{settingId:setting.id,dueAt:Date.now(),confirm:'queue this exact voicemail delivery',...extra},owner,status)
 return {...f,owner,recipient,personId,box,base,write,get,membership,item,settings,queue}
}
