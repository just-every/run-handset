import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
const { Server, utils } = ssh2
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHandset } from './handset-worker.mjs'
import { sourceFixture } from './handset-sources.mjs'
import { post, signIn } from './handset-auth.mjs'

export const range={from:Date.parse('2026-10-01T00:00:00Z'),to:Date.parse('2026-11-01T00:00:00Z'),timezone:'America/Chicago'}
export const encryptionKey='12'.repeat(32)
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
export async function exportFixture(edge,{liveMail=false}={}){
 const runtime=await openHandset({twilio:true,knowledgeEdge:edge?.handle,liveMail}),f=await sourceFixture(runtime),base='/api/handset/exports'
 async function write(path,value,status=201,headers=f.headers){const r=await post(runtime,base+path,value,headers);assert.equal(r.status,status,await r.clone().text());return r.json()}
 async function get(path='',headers=f.headers){const r=await runtime.request(base+path,{headers});assert.equal(r.status,200,await r.clone().text());return r.json()}
 async function media(index,{audio=true,transcript=true}={}){
  const callSid='synthetic-handset-'+(3000+index),recordingSid='synthetic-handset-'+(3100+index),date='Thu, 15 Oct 2026 16:00:00 GMT'
  const call=await f.callback({CallSid:callSid,CallStatus:'completed',SequenceNumber:'0',Timestamp:date,CallDuration:'60'});assert.equal(call.status,200,await call.clone().text());const callReceipt=await call.json(),callId=callReceipt.recordId,caseId=callReceipt.caseId
  f.resource('Recordings',recordingSid,{call_sid:callSid,start_time:date,status:'completed',duration:'60',channels:1})
  const receipt=await f.callback({CallSid:callSid,RecordingSid:recordingSid,RecordingStatus:'completed'});assert.equal(receipt.status,200,await receipt.clone().text());const recordingId=(await receipt.json()).recordId
  const bytes=new Uint8Array([82,73,70,70,index,0,87,65,86,69])
  runtime.twilioResources.set('https://api.twilio.com/2010-04-01/Accounts/'+f.account+'/Recordings/'+recordingSid+'.wav',audio?{__audio:[...bytes]}:{__httpStatus:404})
  const grant=await post(runtime,'/api/handset/recordings/grants',{recordingId,personId:'synthetic-handset-1',expiresAt:Date.now()+3500000,confirm:'approve consented recording for this exact person'},f.headers);assert.equal(grant.status,201,await grant.clone().text())
  let transcriptId=null
  if(transcript){const r=await post(runtime,'/api/handset/transcripts',{recordingId,durationMs:60000,state:'supplied',segments:[{id:'synthetic-handset-3200',speaker:'Caller',language:'en',startMs:1000,endMs:2000,text:'Please call on Tuesday.',confidence:1}],confirm:'authorize supplied transcript for my exact identity'},f.headers);assert.equal(r.status,201,await r.clone().text());transcriptId=(await r.json()).transcriptId}
  return {callId,caseId,recordingId,transcriptId,bytes,grant:await grant.json()}
 }
 async function connector(provider,destination){return write('/connectors',{provider,destination:destination??{folder:provider==='dropbox'?'/synthetic-handset-3300':'synthetic-handset-3300'},credential:'synthetic-handset-3301',retentionDays:30,confirm:'approve scoped destination and separate external custody'})}
 async function archive(connectorId){const job=await write('/jobs',{...range,connectorId,encryptionKey,confirm:'prepare this exact recording archive'});await write('/jobs/'+job.id+'/approve',{previewHash:job.previewHash,confirm:'approve exact archive and separate external custody'},200);return get('/jobs/'+job.id)}
 async function persona(id,role='member'){
  await runtime.sql('INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES (?,?,?,?,?,?)',id,id+'@example.test','Export reviewer',role,'active',Date.now())
  const person=await signIn({...runtime,ownerEmail:id+'@example.test'});return {cookie:person.cookie}
 }
 return {...f,runtime,base,write,get,media,connector,archive,persona}
}
export function archiveEdge(){
 const objects=new Map(),requests=[],uploads=[],byId=new Map();let sequence=3400,loseNext=false,failReadback=false,onDownload=null
 const next=()=> 'synthetic-handset-'+sequence++
 async function handle(request,Response){
  const url=new URL(request.url),host=url.hostname,path=url.pathname
  if(!['api.box.com','upload.box.com','api.dropboxapi.com','content.dropboxapi.com','www.googleapis.com'].includes(host))return null
  requests.push({url:request.url,method:request.method})
  const ok=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})
  const destination='synthetic-handset-3300'
  if(path==='/2.0/users/me')return ok({id:'synthetic-handset-3302',name:'Buyer'})
  if(path==='/2.0/folders/'+destination)return ok({id:destination,name:'Buyer archive',type:'folder',owned_by:{id:'synthetic-handset-3302'},permissions:{can_upload:true}})
  if(path==='/drive/v3/about')return ok({user:{permissionId:'synthetic-handset-3302'}})
  if(path==='/drive/v3/files/'+destination)return ok({id:destination,name:'Buyer archive',mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}})
  if(path==='/2/users/get_current_account')return ok({account_id:'synthetic-handset-3302'})
  if(path==='/2/files/get_metadata'){
   const body=await request.json();if(body.path==='/'+destination)return ok({'.tag':'folder',name:'Buyer archive'})
   const value=objects.get(body.path.split('/').at(-1));return value?ok({'.tag':'file',id:value.id,name:value.name}):ok({error:{'.tag':'path',path:{'.tag':'not_found'}}},409)
  }
  if(path==='/2.0/folders/'+destination+'/items')return ok({entries:[...objects.values()].map(f=>({id:f.id,name:f.name,type:'file'})),total_count:objects.size})
  if(path==='/drive/v3/files/generateIds')return ok({ids:[next()]})
  if(path.startsWith('/drive/v3/files/')&&url.searchParams.get('alt')!=='media'){
   const f=byId.get(path.split('/').at(-1));return f?ok({id:f.id,name:f.name,parents:[destination],trashed:false}):ok({},404)
  }
  if(path==='/2/files/upload'||path==='/api/2.0/files/content'||path==='/upload/drive/v3/files'){
   let name,id,bytes
   if(host==='content.dropboxapi.com'){const arg=JSON.parse(request.headers.get('Dropbox-API-Arg'));assert.equal(arg.mode,'add');assert.equal(arg.autorename,false);name=arg.path.split('/').at(-1);bytes=Buffer.from(await request.arrayBuffer());id=next()}
   else if(host==='upload.box.com'){const form=await request.formData(),attributes=JSON.parse(form.get('attributes'));assert.equal(attributes.parent.id,destination);name=attributes.name;bytes=Buffer.from(await form.get('file').arrayBuffer());id=next()}
   else{const boundary=request.headers.get('content-type').split('boundary=')[1],raw=Buffer.from(await request.arrayBuffer()),first=raw.indexOf('\r\n\r\n'),metadataEnd=raw.indexOf('\r\n--'+boundary,first),meta=JSON.parse(raw.subarray(first+4,metadataEnd).toString()),second=raw.indexOf('\r\n\r\n',metadataEnd),end=raw.lastIndexOf('\r\n--'+boundary+'--');name=meta.name;id=meta.id;bytes=raw.subarray(second+4,end);assert.deepEqual(meta.parents,[destination])}
   if(objects.has(name))return ok({},409)
   const value={name,id,bytes};objects.set(name,value);byId.set(id,value);uploads.push(name)
   if(loseNext){loseNext=false;return new Response(null,{status:503})}
   return ok({id,entries:[{id}]})
  }
  if(path==='/2/files/download'||path.endsWith('/content')||url.searchParams.get('alt')==='media'){
   const name=path==='/2/files/download'?JSON.parse(request.headers.get('Dropbox-API-Arg')).path.split('/').at(-1):byId.get(path.split('/').at(-1)==='content'?path.split('/').at(-2):path.split('/').at(-1))?.name,value=objects.get(name)
   if(onDownload)await onDownload()
   if(failReadback)return new Response(null,{status:503})
   return value?new Response(value.bytes,{headers:{'content-type':'application/octet-stream'}}):ok({},404)
  }
  throw new Error('Unexpected official archive request: '+request.method+' '+url.pathname)
 }
 return {handle,objects,uploads,requests,loseResponse(){loseNext=true},failReadback(value=true){failReadback=value},onDownload(value){onDownload=value}}
}
export async function sftpEdge(){
 const directory=await mkdtemp(join(tmpdir(),'synthetic-handset-sftp-')),host=generateKeyPairSync('rsa',{modulusLength:2048}),client=generateKeyPairSync('rsa',{modulusLength:2048}),privateKey=host.privateKey.export({format:'pem',type:'pkcs1'}),clientPrivate=client.privateKey.export({format:'pem',type:'pkcs1'}),hostKey=utils.parseKey(privateKey),clientKey=utils.parseKey(clientPrivate),objects=new Map(),writes=[],handles=new Map();let sequence=1
 const server=new Server({hostKeys:[privateKey]},connection=>{
  connection.on('error',()=>{})
  connection.on('authentication',ctx=>{if(ctx.method==='publickey'&&ctx.username==='buyer'&&ctx.key.data.equals(clientKey.getPublicSSH())&&(!ctx.signature||clientKey.verify(ctx.blob,ctx.signature,ctx.hashAlgo)))ctx.accept();else ctx.reject()})
  connection.on('ready',()=>connection.on('session',accept=>accept().on('sftp',accept=>{
   const stream=accept(),status=utils.sftp.STATUS_CODE,attrs={mode:0o100600,uid:0,gid:0,size:0,atime:0,mtime:0},directoryAttrs={...attrs,mode:0o40700}
   stream.on('end',()=>stream.end())
   stream.on('REALPATH',(id,path)=>stream.name(id,[{filename:path,longname:path,attrs:directoryAttrs}]))
   stream.on('STAT',(id,path)=>{const f=objects.get(path);if(path==='/archive')stream.attrs(id,directoryAttrs);else if(f)stream.attrs(id,{...attrs,size:f.length});else stream.status(id,status.NO_SUCH_FILE)})
   stream.on('LSTAT',(id,path)=>{const f=objects.get(path);if(path==='/archive')stream.attrs(id,directoryAttrs);else if(f)stream.attrs(id,{...attrs,size:f.length});else stream.status(id,status.NO_SUCH_FILE)})
   stream.on('OPENDIR',(id,path)=>{const h=Buffer.from(String(sequence++));handles.set(h.toString(),{path,directory:true,read:false});stream.handle(id,h)})
   stream.on('READDIR',(id,h)=>{const handle=handles.get(h.toString());if(handle?.read)stream.status(id,status.EOF);else{handle.read=true;stream.name(id,[{filename:'.',longname:'.',attrs:directoryAttrs}])}})
   stream.on('OPEN',(id,path,flags)=>{if((flags&utils.sftp.OPEN_MODE.READ)&&!objects.has(path))return stream.status(id,status.NO_SUCH_FILE);const h=Buffer.from(String(sequence++));handles.set(h.toString(),{path});if(flags&utils.sftp.OPEN_MODE.TRUNC)objects.set(path,Buffer.alloc(0));stream.handle(id,h)})
   stream.on('FSTAT',(id,h)=>{const f=objects.get(handles.get(h.toString())?.path);stream.attrs(id,{...attrs,size:f?.length??0})})
   stream.on('READ',(id,h,offset,length)=>{const f=objects.get(handles.get(h.toString())?.path);if(!f)return stream.status(id,status.NO_SUCH_FILE);if(offset>=f.length)stream.status(id,status.EOF);else stream.data(id,f.subarray(offset,offset+length))})
   stream.on('WRITE',(id,h,offset,data)=>{const path=handles.get(h.toString()).path,old=objects.get(path)??Buffer.alloc(0),next=Buffer.alloc(Math.max(old.length,offset+data.length));old.copy(next);data.copy(next,offset);objects.set(path,next);writes.push(path);stream.status(id,status.OK)})
   stream.on('CLOSE',(id,h)=>{handles.delete(h.toString());stream.status(id,status.OK)})
   stream.on('RENAME',(id,from,to)=>{if(!objects.has(from))return stream.status(id,status.NO_SUCH_FILE);objects.set(to,objects.get(from));objects.delete(from);stream.status(id,status.OK)})
   stream.on('SETSTAT',(id)=>stream.status(id,status.OK));stream.on('FSETSTAT',id=>stream.status(id,status.OK))
  })))
 })
 await new Promise((done,fail)=>server.once('error',fail).listen(0,'127.0.0.1',done))
 const port=server.address().port,identityFile=join(directory,'identity'),knownHostsFile=join(directory,'known_hosts'),fingerprint='SHA256:'+createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/,'')
 await writeFile(identityFile,clientPrivate,{mode:0o600});await writeFile(knownHostsFile,'[127.0.0.1]:'+port+' '+hostKey.type+' '+hostKey.getPublicSSH().toString('base64')+'\n',{mode:0o600})
 return {objects,writes,destination:{host:'127.0.0.1',port,user:'buyer',folder:'/archive',hostKey:fingerprint},identityFile,knownHostsFile,async close(){await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true})}}
}
