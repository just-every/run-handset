import { digest, Fault, id, text } from '../core'
import { statement, write, type Context } from './storage'
import type { QueueBinding } from './provider-consent'

export interface BoundSource extends QueueBinding {account_id:string;number_id:string;source_owner_id:string;source_owner_version:number;source_revision:number;number_data:string}
export async function boundSource(env:Context['env'],bindingId:string){
 return env.DB.prepare(`SELECT b.*,s.account_id,s.number_id,s.owner_id AS source_owner_id,s.owner_version AS source_owner_version,s.revision AS source_revision,n.data AS number_data FROM hnd_queue_bindings b JOIN hnd_sources s ON s.id=b.source_id JOIN hnd_records n ON n.id=s.number_id JOIN oa_operators bo ON bo.id=b.owner_id JOIN oa_operators so ON so.id=s.owner_id WHERE b.id=? AND b.revoked_at IS NULL AND s.revoked_at IS NULL AND bo.status='active' AND bo.role='owner' AND so.status='active' AND so.role='owner'`).bind(bindingId).first<BoundSource>()
}
export async function verifyQueueRequest(request:Request,env:Context['env'],p:URLSearchParams){
 const signature=request.headers.get('x-twilio-signature')
 if(!env.HANDSET_TWILIO_AUTH_TOKEN||!signature||!/^[A-Za-z0-9+/]{27}=$/.test(signature))throw new Fault('invalid_queue_source_proof',403)
 for(const name of p.keys())if(p.getAll(name).length!==1)throw new Fault('duplicate_source_field')
 let signed=request.url
 for(const name of [...new Set(p.keys())].sort())signed+=name+p.get(name)
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.HANDSET_TWILIO_AUTH_TOKEN),{name:'HMAC',hash:'SHA-1'},false,['verify'])
 const bytes=Uint8Array.from(atob(signature),v=>v.charCodeAt(0))
 if(!await crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode(signed)))throw new Fault('invalid_queue_source_proof',403)
}
export function sourceContext(env:Context['env'],source:BoundSource):Context {
 return {env,auditActor:source.source_id,observation:'signed provider call status',fences:()=>[
  env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_queue_bindings b JOIN oa_operators bo ON bo.id=b.owner_id JOIN hnd_sources s ON s.id=b.source_id JOIN oa_operators so ON so.id=s.owner_id WHERE b.id=? AND b.revoked_at IS NULL AND bo.status='active' AND bo.role='owner' AND s.revoked_at IS NULL AND s.revision=? AND so.status='active' AND so.role='owner'`).bind(source.id,source.source_revision),
 ]}
}
export async function sourceCall(ctx:Context,source:BoundSource,p:URLSearchParams){
 const sid=text(p.get('CallSid'),'CallSid'),from=text(p.get('From'),'From'),to=text(p.get('To'),'To'),own=JSON.parse(source.number_data).e164
 if(!/^\+[1-9]\d{7,14}$/.test(from)||to!==own||from===own)throw new Fault('queue_number_out_of_scope',403)
 const existing=await statement(ctx,'SELECT record_id,case_id FROM hnd_source_objects WHERE source_id=? AND external_id=?',source.source_id,sid).first<{record_id:string;case_id:string}>()
 if(existing){
  const record=await statement(ctx,"SELECT data FROM hnd_records WHERE id=? AND kind='call_session'",existing.record_id).first<{data:string}>()
  const data=record&&JSON.parse(record.data)
  if(!data||data.direction!=='inbound'||data.from!==from||data.to!==to)throw new Fault('queue_call_identity_conflict',409)
  return existing.record_id
 }
 // Twilio's Voice URL request carries no reliable occurrence timestamp.
 // Read its official Call resource; a missing edge is an explicit failure.
 let response:Response
 try{response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(source.account_id)}/Calls/${encodeURIComponent(sid)}.json`,{headers:{authorization:'Basic '+btoa(source.account_id+':'+ctx.env.HANDSET_TWILIO_AUTH_TOKEN)},redirect:'manual',signal:AbortSignal.timeout(5000)})}catch{throw new Fault('queue_call_readback_unavailable',503)}
 if(response.status!==200)throw new Fault('queue_call_readback_unavailable',503)
 let call:Record<string,unknown>
 try{call=await response.json()}catch{throw new Fault('invalid_queue_call_readback',502)}
 if(call.sid!==sid||call.account_sid!==source.account_id||call.from!==from||call.to!==to||call.direction!=='inbound'||!['queued','ringing','in-progress'].includes(String(call.status)))throw new Fault('queue_call_readback_identity_mismatch',502)
 const occurredAt=Date.parse(String(call.date_created))
 if(!Number.isFinite(occurredAt))throw new Fault('queue_call_timestamp_required',503)
 const correlation=await digest([source.source_id,own,from]),priorCase=await statement(ctx,'SELECT case_id FROM hnd_source_cases WHERE source_id=? AND correlation=?',source.source_id,correlation).first<{case_id:string}>()
 const caseId=priorCase?.case_id??id(),recordId=id(),now=Date.now(),statements:D1PreparedStatement[]=[]
 if(!priorCase){
  statements.push(statement(ctx,'INSERT INTO hnd_cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',caseId,'Inbound queue call',source.source_owner_id,null,'','open',0,1,1,source.source_owner_id,now,''),statement(ctx,'INSERT INTO hnd_source_cases VALUES (?,?,?)',source.source_id,correlation,caseId))
 }
 statements.push(statement(ctx,'INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)',recordId,'call_session','native',source.source_id+':queue:'+sid,occurredAt,now,caseId,null,null,JSON.stringify({direction:'inbound',providerStatus:call.status,from,to,customerOutcome:'unconfirmed'}),source.source_id),
  statement(ctx,'INSERT INTO hnd_record_sources VALUES (?,?,?,?)',recordId,source.source_id,'twilio','queue:'+sid),
  statement(ctx,'INSERT INTO hnd_source_objects VALUES (?,?,?,?)',source.source_id,sid,recordId,caseId))
 await write(ctx,recordId,statements)
 return recordId
}
