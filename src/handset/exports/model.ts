import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, integer, text, type ObjectValue } from '../core'
import { guard, sql } from '../delegation/store'
import { commit } from '../audit/store'

export interface Filters {from:number;to:number;timezone:string;queueId:string|null;ownerId:string|null}
export interface Connector {id:string;provider:'box'|'dropbox'|'google-drive'|'sftp';destination:string;preview:string;owner_id:string;owner_version:number;retention_days:number;created_at:number;revoked_at:number|null}
export interface Job {id:string;connector_id:string;person_id:string;person_version:number;filters:string;key_hash:string;state:string;approved_by:string|null;owner_version:number|null;approved_at:number|null;created_at:number;retain_until:number;lease_until:number;error:string|null;manifest_hash:string|null}
export interface FileRow {job_id:string;file_key:string;kind:'audio'|'transcript'|'manifest';recording_id:string|null;native_id:string|null;source_id:string|null;external_id:string|null;call_id:string|null;recorded_at:number|null;iv:string;state:string;reason:string|null;plain_hash:string|null;cipher_hash:string|null;size_bytes:number|null;remote_id:string|null}
export const custody='Delivered files are in separate buyer custody. Revocation stops new transfers and cannot recall existing copies. The buyer enforces remote retention and holds the decryption key.'
export function admin(actor:Session){if(!['owner','admin'].includes(actor.operator.role))throw new Fault('export_admin_required',403)}
export const adminFence=(env:Bindings,actor:Session)=>guard(env,`SELECT count(*) FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id WHERE s.id=? AND s.operator_id=? AND s.operator_version=o.version AND o.version=? AND o.role IN ('owner','admin') AND o.status='active' AND s.revoked_at IS NULL AND s.expires_at>?`,actor.id,actor.operator.id,actor.operator.version,Date.now())
export async function event(env:Bindings,actor:Session,action:string,subject:string,statements:D1PreparedStatement[]=[],outcome='completed'){await commit(env,actor,action,subject,outcome,[adminFence(env,actor),...statements],false)}
export function filters(v:ObjectValue):Filters {
 const from=integer(Number(v.from),'from',0,8640000000000000),to=integer(Number(v.to),'to',from+1,8640000000000000),timezone=text(v.timezone,'timezone',100)
 try{new Intl.DateTimeFormat('en-US',{timeZone:timezone})}catch{throw new Fault('invalid_timezone')}
 return {from,to,timezone,queueId:v.queueId?text(v.queueId,'queueId'):null,ownerId:v.ownerId?text(v.ownerId,'ownerId'):null}
}
export const hex=(bytes:Uint8Array)=>[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('')
export async function hash(bytes:Uint8Array){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))))}
export function keyBytes(value:unknown){const key=text(value,'encryptionKey',64);if(!/^[a-f0-9]{64}$/.test(key))throw new Fault('aes256_key_required');return Uint8Array.from(key.match(/../g)!,part=>parseInt(part,16))}
export const fileName=(job:Job,file:FileRow)=>job.id+'.'+file.file_key+'.'+(file.kind==='audio'?'wav':file.kind==='transcript'?'json':'manifest.json')+'.aes'
export const getConnector=async(env:Bindings,target:string)=>{const row=await sql(env,'SELECT * FROM hnd_export_connectors WHERE id=?',target).first<Connector>();if(!row)throw new Fault('export_connector_not_found',404);return row}
export const connectorFence=(env:Bindings,c:Connector)=>guard(env,`SELECT count(*) FROM hnd_export_connectors c JOIN oa_operators o ON o.id=c.owner_id WHERE c.id=? AND c.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=c.owner_version`,c.id)
export async function getJob(env:Bindings,actor:Session,target:string){const j=await sql(env,'SELECT * FROM hnd_export_jobs WHERE id=?',target).first<Job>();if(!j)throw new Fault('export_not_found',404);if(j.person_id!==actor.operator.id&&actor.operator.role!=='owner')throw new Fault('exact_export_person_required',403);return j}
export const files=(env:Bindings,j:Job)=>sql(env,'SELECT * FROM hnd_export_files WHERE job_id=? ORDER BY CASE WHEN kind=\'manifest\' THEN 1 ELSE 0 END,file_key',j.id).all<FileRow>()
export function jobFence(env:Bindings,j:Job){return guard(env,`SELECT count(*) FROM hnd_export_jobs j JOIN hnd_export_connectors c ON c.id=j.connector_id JOIN oa_operators o ON o.id=j.approved_by JOIN oa_operators p ON p.id=j.person_id JOIN oa_operators co ON co.id=c.owner_id WHERE j.id=? AND j.state IN ('approved','transferring','interrupted','verified','client_verified') AND j.retain_until>? AND j.person_version=p.version AND p.status='active' AND p.role IN ('owner','admin') AND o.role='owner' AND o.status='active' AND o.version=j.owner_version AND c.revoked_at IS NULL AND co.role='owner' AND co.status='active' AND co.version=c.owner_version`,j.id,Date.now())}
export async function authorizeJob(env:Bindings,actor:Session,j:Job){if(j.person_id!==actor.operator.id||j.person_version!==actor.operator.version)throw new Fault('exact_export_person_required',403);try{await env.DB.batch([adminFence(env,actor),jobFence(env,j),sql(env,'DELETE FROM hnd_guard')])}catch{throw new Fault('export_authority_changed',409)}}
