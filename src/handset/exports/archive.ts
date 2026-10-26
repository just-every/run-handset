import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, digest, id, text, owner, integer, type ObjectValue } from '../core'
import { guard, sql } from '../delegation/store'
import { recordingAccess, recordingDoor } from '../recording/doors'
import { transcriptDoor } from '../transcripts/doors'
import { callRows } from './logs'
import { authorizeJob, connectorFence, custody, event, fileName, files, filters, getConnector, hash, hex, jobFence, keyBytes, type Job, type FileRow } from './model'
import { boundedBytes, download, lookup, preview, reserveDriveId, upload, type Destination } from './transport'

const encoder=new TextEncoder()
const nonce=()=>hex(crypto.getRandomValues(new Uint8Array(12)))
export async function prepareArchive(env:Bindings,actor:Session,v:ObjectValue){
 const c=await getConnector(env,text(v.connectorId,'connectorId')),f=filters(v),key=keyBytes(v.encryptionKey),target=id(),now=Date.now()
 if(v.confirm!=='prepare this exact recording archive')throw new Fault('export_prepare_confirmation_required',403)
 const calls=await callRows(env,f),ids=[...new Set(calls.map(r=>r.id))],recordings=(await sql(env,`SELECT r.id,r.parent_id,r.occurred_at,rs.source_id,so.external_id,(SELECT t.id FROM hnd_transcripts t WHERE t.recording_id=r.id) AS transcript_id FROM hnd_records r LEFT JOIN hnd_record_sources rs ON rs.record_id=r.id LEFT JOIN hnd_source_objects so ON so.record_id=r.id AND so.source_id=rs.source_id WHERE r.kind='recording' AND r.parent_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM hnd_records n WHERE n.supersedes_id=r.id) ORDER BY r.occurred_at,r.id`,JSON.stringify(ids)).all<{id:string;parent_id:string;occurred_at:number;source_id:string|null;external_id:string|null;transcript_id:string|null}>()).results
 if(recordings.length>2000)throw new Fault('select_at_most_2000_recordings',413)
 // Snapshot every selected identity, including media that cannot be retrieved.
 const statements=[connectorFence(env,c),sql(env,`INSERT INTO hnd_export_jobs(id,connector_id,person_id,person_version,filters,key_hash,state,created_at,retain_until) VALUES (?,?,?,?,?,?,'building',?,?)`,target,c.id,actor.operator.id,actor.operator.version,JSON.stringify(f),await hash(key),now,now+c.retention_days*86400000)]
 for(const r of recordings)for(const kind of ['audio','transcript'] as const)statements.push(sql(env,`INSERT INTO hnd_export_files(job_id,file_key,kind,recording_id,native_id,source_id,external_id,call_id,recorded_at,iv,state,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,target,kind+'-'+r.id,kind,r.id,kind==='audio'?r.id:r.transcript_id,r.source_id,r.external_id,r.parent_id,r.occurred_at,nonce(),kind==='transcript'&&!r.transcript_id?'unavailable':'pending',kind==='transcript'&&!r.transcript_id?'transcript_not_supplied':null))
 statements.push(sql(env,"INSERT INTO hnd_export_files(job_id,file_key,kind,iv,state) VALUES (?,'manifest','manifest',?,'pending')",target,nonce()))
 // D1 bounds transaction statement count; each batch is fenced and incomplete jobs remain unapproved.
 await event(env,actor,'exports.create',target,statements.slice(0,1).concat(statements.slice(1,2)))
 for(let offset=2;offset<statements.length;offset+=50)await event(env,actor,'exports.create',target,[connectorFence(env,c),guard(env,"SELECT count(*) FROM hnd_export_jobs WHERE id=? AND state='building'",target),...statements.slice(offset,offset+50)])
 await event(env,actor,'exports.create',target,[connectorFence(env,c),guard(env,"SELECT count(*) FROM hnd_export_jobs WHERE id=? AND state='building'",target),sql(env,"UPDATE hnd_export_jobs SET state='prepared' WHERE id=?",target)])
 return target
}
export async function archivePreview(env:Bindings,j:Job){
 const c=await getConnector(env,j.connector_id),rows=(await files(env,j)).results
 const selection={id:j.id,connectorId:c.id,destination:JSON.parse(c.preview),filters:JSON.parse(j.filters),personId:j.person_id,personVersion:j.person_version,retainUntil:j.retain_until,keyHash:j.key_hash,files:rows.map(f=>({fileKey:f.file_key,kind:f.kind,recordingId:f.recording_id,sourceId:f.source_id,externalId:f.external_id,callId:f.call_id,recordedAt:f.recorded_at,transcriptId:f.kind==='transcript'?f.native_id:null}))}
 return {...selection,previewHash:await digest(selection),state:j.state,error:j.error,manifestHash:j.manifest_hash,custody,files:rows.map(f=>({...selection.files.find(x=>x.fileKey===f.file_key),name:fileName(j,f),state:f.state,reason:f.reason,sha256:f.plain_hash,cipherSha256:f.cipher_hash,size:f.size_bytes,remoteId:f.remote_id}))}
}
export async function approveArchive(env:Bindings,actor:Session,j:Job,v:ObjectValue){
 owner(actor);if(v.confirm!=='approve exact archive and separate external custody')throw new Fault('explicit_archive_approval_required',403)
 if(v.previewHash!==(await archivePreview(env,j)).previewHash)throw new Fault('export_preview_changed',409)
 const c=await getConnector(env,j.connector_id)
 await event(env,actor,'exports.approve',j.id,[guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND role='owner' AND status='active' AND version=?",actor.operator.id,actor.operator.version),connectorFence(env,c),guard(env,"SELECT count(*) FROM hnd_export_jobs WHERE id=? AND state='prepared'",j.id),sql(env,"UPDATE hnd_export_jobs SET state='approved',approved_by=?,owner_version=?,approved_at=? WHERE id=?",actor.operator.id,actor.operator.version,Date.now(),j.id)])
}
function transcriptFence(env:Bindings,actor:Session,target:string){return guard(env,`SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_transcript_access g JOIN oa_operators p ON p.id=g.person_id JOIN oa_operators o ON o.id=g.created_by WHERE g.transcript_id=? AND g.person_id=? AND g.person_version=p.version AND p.status='active' AND o.version=g.owner_version AND o.role='owner' AND o.status='active' AND g.revoked_at IS NULL AND g.expires_at>?) THEN 1 ELSE 0 END`,target,actor.operator.id,Date.now())}
async function contentFences(env:Bindings,actor:Session,f:FileRow){
 const access=await recordingAccess(env,actor,f.recording_id!),fences=access.fences()
 if(f.kind==='transcript'){const response=await transcriptDoor(new Request(env.AUTH_ORIGIN+'/api/handset/transcripts/'+f.native_id),env,actor);if(!response?.ok)throw new Fault('transcript_access_required',403);fences.push(transcriptFence(env,actor,f.native_id!))}
 await env.DB.batch([...fences,sql(env,'DELETE FROM hnd_guard')]);return fences
}
export async function manifest(env:Bindings,actor:Session,j:Job){
 await authorizeJob(env,actor,j)
 const c=await getConnector(env,j.connector_id),rows=(await files(env,j)).results.filter(f=>f.kind!=='manifest')
 if(rows.some(f=>f.state==='pending'||f.state==='ready'))throw new Fault('export_files_pending',409)
 for(const f of rows.filter(f=>f.state==='verified'||f.state==='client_verified'))await contentFences(env,actor,f)
 return {format:'handset-encrypted-archive-v1',exportId:j.id,createdAt:j.created_at,filters:JSON.parse(j.filters),approvedBy:j.approved_by,approvedAt:j.approved_at,policy:{exactPerson:j.person_id,version:j.person_version,recordingGrantRequired:true,separateTranscriptGrantRequired:true,custody,encryption:'AES-256-GCM; first 12 bytes are nonce, remaining bytes ciphertext with 128-bit tag; associated data is export ID then colon then file key',retentionDays:c.retention_days,retainUntil:j.retain_until,retentionEnforcement:'buyer-managed remote retention'},destination:JSON.parse(c.preview),recordingCount:new Set(rows.map(f=>f.recording_id)).size,files:rows.map(f=>({recordingId:f.recording_id,sourceId:f.source_id,externalId:f.external_id,callId:f.call_id,recordedAt:f.recorded_at,kind:f.kind,name:f.state==='unavailable'?null:fileName(j,f),state:f.state,reason:f.reason,sha256:f.plain_hash,cipherSha256:f.cipher_hash,size:f.size_bytes,remoteId:f.remote_id,transcriptLink:f.kind==='transcript'&&f.native_id?'/api/handset/transcripts/'+f.native_id:null}))}
}
export async function artifact(env:Bindings,actor:Session,j:Job,f:FileRow,keyValue:unknown):Promise<Uint8Array<ArrayBuffer>|null>{
 await authorizeJob(env,actor,j)
 const key=keyBytes(keyValue);if(await hash(key)!==j.key_hash)throw new Fault('export_encryption_key_mismatch',403)
 if(f.state==='unavailable')return null
 let plain:Uint8Array,fences:D1PreparedStatement[]=[]
 if(f.kind==='manifest')plain=encoder.encode(JSON.stringify(await manifest(env,actor,j),null,2)+'\n')
 else{
  try{
   fences=await contentFences(env,actor,f)
   if(f.kind==='audio'){
    const response=await recordingDoor(new Request(env.AUTH_ORIGIN+'/api/handset/recordings/'+f.recording_id+'/playback'),env,actor)
    if(!response||!response.ok)throw new Fault('recording_media_unavailable',503)
    plain=await boundedBytes(response)
   }else{
    const response=await transcriptDoor(new Request(env.AUTH_ORIGIN+'/api/handset/transcripts/'+f.native_id),env,actor)
    if(!response||!response.ok)throw new Fault('transcript_unavailable',503)
    const value=await response.json() as {state:string;reason:string}
    if(value.state!=='supplied')throw new Fault('transcript_missing',404)
    plain=encoder.encode(JSON.stringify(value,null,2)+'\n')
   }
  }catch(error){
   if(!(error instanceof Fault))throw error
   if(f.plain_hash)throw new Fault('export_content_authority_or_source_changed',409)
   await event(env,actor,'exports.transfer',j.id,[jobFence(env,j),sql(env,"UPDATE hnd_export_files SET state='unavailable',reason=? WHERE job_id=? AND file_key=? AND plain_hash IS NULL",error.code,j.id,f.file_key)],'failed');return null
  }
 }
 const plainHash=await hash(plain),iv=Uint8Array.from(f.iv.match(/../g)!,p=>parseInt(p,16))
 if(f.plain_hash&&f.plain_hash!==plainHash)throw new Fault('export_source_changed',409)
 await event(env,actor,'exports.transfer',j.id,[jobFence(env,j),...fences,guard(env,'SELECT count(*) FROM hnd_export_files WHERE job_id=? AND file_key=? AND (plain_hash IS NULL OR plain_hash=?)',j.id,f.file_key,plainHash),sql(env,'UPDATE hnd_export_files SET plain_hash=? WHERE job_id=? AND file_key=?',plainHash,j.id,f.file_key)])
 const cryptoKey=await crypto.subtle.importKey('raw',key,'AES-GCM',false,['encrypt']),cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(j.id+':'+f.file_key)},cryptoKey,new Uint8Array(plain))),bytes=new Uint8Array(iv.length+cipher.length);bytes.set(iv);bytes.set(cipher,iv.length)
 await event(env,actor,'exports.transfer',j.id,[jobFence(env,j),...fences,sql(env,"UPDATE hnd_export_files SET plain_hash=?,cipher_hash=?,size_bytes=?,state=CASE WHEN state IN ('verified','client_verified') THEN state ELSE 'ready' END WHERE job_id=? AND file_key=?",plainHash,await hash(bytes),bytes.length,j.id,f.file_key)])
 return bytes
}
export async function transferArchive(env:Bindings,actor:Session,j:Job,v:ObjectValue){
 await authorizeJob(env,actor,j)
 const c=await getConnector(env,j.connector_id),credential=text(v.credential,'credential',8000)
 if(c.provider==='sftp')throw new Fault('sftp_buyer_command_required',409)
 const fresh=await preview(c.provider,JSON.parse(c.destination) as Destination,credential),original=JSON.parse(c.preview)
 if(fresh.account!==original.account)throw new Fault('export_destination_account_changed',403)
 const limit=integer(v.limit??10,'limit',1,50),lease=Date.now()+120000
 await event(env,actor,'exports.transfer',j.id,[jobFence(env,j),guard(env,'SELECT count(*) FROM hnd_export_jobs WHERE id=? AND lease_until<?',j.id,Date.now()),sql(env,"UPDATE hnd_export_jobs SET lease_until=?,state='transferring',error=NULL WHERE id=?",lease,j.id)])
 let transferred=0
 try{
  for(const f of (await files(env,j)).results){
   if(f.state==='unavailable'||f.state==='verified')continue
   if(transferred>=limit)break
   const bytes=await artifact(env,actor,j,f,v.encryptionKey);if(!bytes)continue
   const name=fileName(j,f),expected=await hash(bytes)
   if(c.provider==='google-drive'&&!f.remote_id){f.remote_id=await reserveDriveId(credential);await event(env,actor,'exports.transfer',j.id,[jobFence(env,j),sql(env,'UPDATE hnd_export_files SET remote_id=? WHERE job_id=? AND file_key=?',f.remote_id,j.id,f.file_key)])}
   // Read before write: a lost upload acknowledgement never authorizes a duplicate.
   let remote=await lookup(c,credential,name,f.remote_id)
   await authorizeJob(env,actor,j);if(f.kind!=='manifest')await contentFences(env,actor,f)
   if(!remote){await upload(c,credential,name,bytes,f.remote_id);remote=await lookup(c,credential,name,f.remote_id)}
   if(!remote)throw new Fault('export_transfer_readback_pending',503)
   const readback=await download(c,credential,remote,name)
   if(readback.hash!==expected||readback.size!==bytes.length)throw new Fault('export_remote_checksum_mismatch',409)
   const fences=f.kind==='manifest'?[]:await contentFences(env,actor,f)
   await event(env,actor,'exports.transfer',j.id,[jobFence(env,j),...fences,sql(env,"UPDATE hnd_export_files SET state='verified',remote_id=? WHERE job_id=? AND file_key=? AND cipher_hash=?",remote,j.id,f.file_key,expected),...(f.kind==='manifest'?[sql(env,'UPDATE hnd_export_jobs SET manifest_hash=? WHERE id=?',expected,j.id)]:[])])
   transferred++
  }
  const pending=(await files(env,j)).results.some(f=>!['verified','unavailable'].includes(f.state))
  await event(env,actor,'exports.transfer',j.id,[jobFence(env,j),sql(env,"UPDATE hnd_export_jobs SET state=?,lease_until=0 WHERE id=?",pending?'approved':'verified',j.id)])
 }catch(error){
  const code=error instanceof Fault?error.code:'export_transfer_interrupted'
  await event(env,actor,'exports.transfer',j.id,[sql(env,"UPDATE hnd_export_jobs SET state=CASE WHEN state='revoked' THEN state ELSE 'interrupted' END,lease_until=0,error=? WHERE id=?",code,j.id)],'failed')
  throw error instanceof Fault?error:new Fault(code,503)
 }
 return {transferred,...await archivePreview(env,(await sql(env,'SELECT * FROM hnd_export_jobs WHERE id=?',j.id).first<Job>())!)}
}
export async function clientReceipt(env:Bindings,actor:Session,j:Job,v:ObjectValue){
 await authorizeJob(env,actor,j)
 const c=await getConnector(env,j.connector_id)
 if(c.provider!=='sftp'||v.confirm!=='I independently downloaded and verified this encrypted SFTP file')throw new Fault('sftp_independent_readback_required',403)
 const f=(await files(env,j)).results.find(f=>f.file_key===v.fileKey),d=JSON.parse(c.destination) as Destination
 if(!f||!f.cipher_hash||v.cipherSha256!==f.cipher_hash||v.remotePath!==d.folder+'/'+fileName(j,f))throw new Fault('export_readback_mismatch',409)
 const fences=f.kind==='manifest'?[]:await contentFences(env,actor,f)
 await event(env,actor,'exports.transfer',j.id,[jobFence(env,j),...fences,sql(env,"UPDATE hnd_export_files SET state='client_verified',remote_id=? WHERE job_id=? AND file_key=?",text(v.remotePath,'remotePath',1000),j.id,f.file_key),...(f.kind==='manifest'?[sql(env,"UPDATE hnd_export_jobs SET state='client_verified',manifest_hash=? WHERE id=?",f.cipher_hash,j.id)]:[])])
 return {state:'client_verified',verification:'Buyer OpenSSH download readback attested by the exact export person; no server-side SFTP receipt is claimed.'}
}
