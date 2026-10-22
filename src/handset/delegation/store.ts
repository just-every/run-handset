import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { append, actorRef, commit } from '../audit/store'
import { choice, Fault, id, integer, keys, owner, text, type ObjectValue } from '../core'

export interface Line {id:string;principal_id:string;number_id:string;source_id:string;timezone:string;opens:string;closes:string;weekdays:string;dnd:number;forward_to:string|null;revision:number;created_by:string;owner_version:number}
export interface Delegation {id:string;line_id:string;assistant_id:string;assistant_version:number;principal_version:number;created_by:string;owner_version:number;expires_at:number;revoked_at:number|null}
export const sql=(env:Bindings,q:string,...values:(string|number|null)[])=>env.DB.prepare(q).bind(...values)
export const guard=(env:Bindings,q:string,...values:(string|number|null)[])=>sql(env,'INSERT INTO hnd_guard(ok) '+q,...values)
export function nativeFence(env:Bindings,actor:Session){return guard(env,`SELECT count(*) FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id WHERE s.id=? AND s.operator_id=? AND s.operator_version=o.version AND o.status='active' AND s.revoked_at IS NULL AND s.expires_at>?`,actor.id,actor.operator.id,Date.now())}
export async function line(env:Bindings,lineId:string){const r=await sql(env,'SELECT * FROM hnd_frontdesk_lines WHERE id=?',lineId).first<Line>();if(!r)throw new Fault('line_not_found',404);return r}
export function delegationFence(env:Bindings,actor:Session,d:Delegation,l:Line){return guard(env,`SELECT count(*) FROM hnd_delegations d JOIN hnd_frontdesk_lines l ON l.id=d.line_id JOIN oa_operators a ON a.id=d.assistant_id JOIN oa_operators p ON p.id=l.principal_id JOIN oa_operators o ON o.id=d.created_by JOIN hnd_sources s ON s.id=l.source_id JOIN oa_operators so ON so.id=s.owner_id JOIN oa_operators lo ON lo.id=l.created_by WHERE d.id=? AND d.assistant_id=? AND d.revoked_at IS NULL AND d.expires_at>? AND a.version=d.assistant_version AND a.status='active' AND p.version=d.principal_version AND p.status='active' AND o.version=d.owner_version AND o.role='owner' AND o.status='active' AND l.revision=? AND lo.version=l.owner_version AND lo.role='owner' AND lo.status='active' AND s.revoked_at IS NULL AND s.number_id=l.number_id AND so.version=s.owner_version AND so.role='owner' AND so.status='active'`,d.id,actor.operator.id,Date.now(),l.revision)}
export async function delegated(env:Bindings,actor:Session,delegationId:string){
 const d=await sql(env,'SELECT * FROM hnd_delegations WHERE id=? AND assistant_id=?',delegationId,actor.operator.id).first<Delegation>()
 if(!d)throw new Fault('delegation_required',403)
 const l=await line(env,d.line_id)
 // Use the same predicate as the atomic operation fence before any read.
 try{await env.DB.batch([nativeFence(env,actor),delegationFence(env,actor,d,l),sql(env,'DELETE FROM hnd_guard')])}catch{throw new Fault('delegation_inactive',403)}
 return {d,l}
}
export async function configureLine(env:Bindings,actor:Session,v:ObjectValue){
 owner(actor);keys(v,['id','revision','principalId','numberId','sourceId','timezone','opens','closes','weekdays','dnd','forwardTo','confirm'])
 if(v.confirm!=='approve exact executive line policy')throw new Fault('line_consent_required',403)
 const target=v.id?text(v.id,'id'):id(),previous=v.id?await line(env,target):null,revision=previous?integer(v.revision,'revision',1):0
 if(previous&&revision!==previous.revision)throw new Fault('line_version_conflict',409)
 const principal=text(v.principalId,'principalId'),number=text(v.numberId,'numberId'),source=text(v.sourceId,'sourceId'),timezone=text(v.timezone,'timezone'),opens=text(v.opens,'opens'),closes=text(v.closes,'closes')
 try{new Intl.DateTimeFormat('en-US',{timeZone:timezone})}catch{throw new Fault('invalid_timezone')}
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(opens)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(closes)||opens>=closes)throw new Fault('invalid_working_hours')
 if(!Array.isArray(v.weekdays)||!v.weekdays.length||v.weekdays.length>7)throw new Fault('invalid_weekdays')
 const weekdays=JSON.stringify([...new Set(v.weekdays.map(n=>integer(n,'weekday',0,6)))].sort()),dnd=v.dnd===true?1:v.dnd===false?0:integer(v.dnd??0,'dnd',0,1),forward=v.forwardTo?text(v.forwardTo,'forwardTo'):null
 if(forward&&!/^\+[1-9]\d{7,14}$/.test(forward))throw new Fault('invalid_forwarding_destination')
 const values=[principal,number,source,timezone,opens,closes,weekdays,dnd,forward,revision+1,actor.operator.id,actor.operator.version] as const
 await commit(env,actor,'line.configure',target,'completed',[
  guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND status='active'",principal),
  guard(env,`SELECT count(*) FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id JOIN hnd_records n ON n.id=s.number_id WHERE s.id=? AND s.number_id=? AND s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=s.owner_version AND n.kind='number' AND NOT EXISTS(SELECT 1 FROM hnd_records r WHERE r.supersedes_id=n.id) AND ( ? IS NULL OR json_extract(n.data,'$.e164')!=?)`,source,number,forward,forward),
  ...(previous?[guard(env,'SELECT count(*) FROM hnd_frontdesk_lines WHERE id=? AND revision=?',target,revision),sql(env,'UPDATE hnd_frontdesk_lines SET principal_id=?,number_id=?,source_id=?,timezone=?,opens=?,closes=?,weekdays=?,dnd=?,forward_to=?,revision=?,created_by=?,owner_version=? WHERE id=?',...values,target),sql(env,'UPDATE hnd_delegations SET revoked_at=COALESCE(revoked_at,?) WHERE line_id=?',Date.now(),target)]:[sql(env,'INSERT INTO hnd_frontdesk_lines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',target,...values)]),
 ])
 return line(env,target)
}
export async function createDelegation(env:Bindings,actor:Session,v:ObjectValue){
 owner(actor);keys(v,['lineId','assistantId','expiresAt','confirm'])
 if(v.confirm!=='approve exact assistant and executive line')throw new Fault('delegation_consent_required',403)
 const l=await line(env,text(v.lineId,'lineId')),assistant=text(v.assistantId,'assistantId'),expires=integer(v.expiresAt,'expiresAt',Date.now()+1000,Date.now()+86400000),target=id()
 if(assistant===l.principal_id)throw new Fault('distinct_assistant_required')
 const a=await sql(env,"SELECT version FROM oa_operators WHERE id=? AND status='active'",assistant).first<{version:number}>(),p=await sql(env,"SELECT version FROM oa_operators WHERE id=? AND status='active'",l.principal_id).first<{version:number}>()
 if(!a||!p)throw new Fault('active_people_required',409)
 await commit(env,actor,'delegation.create',target,'completed',[guard(env,'SELECT count(*) FROM hnd_frontdesk_lines WHERE id=? AND revision=?',l.id,l.revision),guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'",assistant,a.version),guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'",l.principal_id,p.version),sql(env,'INSERT INTO hnd_delegations VALUES (?,?,?,?,?,?,?,?,NULL,?)',target,l.id,assistant,a.version,p.version,actor.operator.id,actor.operator.version,expires,Date.now())])
 return {id:target,lineId:l.id,assistantId:assistant,expiresAt:expires,scope:'selected line call controls only; no recording, porting or administration'}
}
export async function revokeDelegation(env:Bindings,actor:Session,target:string){owner(actor);await commit(env,actor,'delegation.revoke',target,'completed',[guard(env,'SELECT count(*) FROM hnd_delegations WHERE id=?',target),sql(env,'UPDATE hnd_delegations SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',Date.now(),target)]);return {revoked:true,existingCalls:'preserved'}}
export function linePolicy(l:Line,now=Date.now()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:l.timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value])),day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday),time=parts.hour+':'+parts.minute
 return {dnd:Boolean(l.dnd),withinHours:(JSON.parse(l.weekdays) as number[]).includes(day)&&time>=l.opens&&time<l.closes,forwardTo:l.forward_to}
}
export async function presence(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['state','revision']);const state=choice(v.state,['available','busy','away','dnd','offline'],'state'),revision=integer(v.revision,'revision',0),now=Date.now()
 await commit(env,actor,'presence.change','installation','completed',[nativeFence(env,actor),guard(env,'SELECT CASE WHEN ?=0 THEN NOT EXISTS(SELECT 1 FROM hnd_frontdesk_presence WHERE operator_id=?) ELSE EXISTS(SELECT 1 FROM hnd_frontdesk_presence WHERE operator_id=? AND revision=?) END',revision,actor.operator.id,actor.operator.id,revision),sql(env,'INSERT INTO hnd_frontdesk_presence VALUES (?,?,?,?) ON CONFLICT(operator_id) DO UPDATE SET state=excluded.state,observed_at=excluded.observed_at,revision=excluded.revision',actor.operator.id,state,now,revision+1)],false)
 return {state,observedAt:now,revision:revision+1}
}
export async function intent(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['delegationId','kind','callId','target','lineRevision','idempotencyKey'])
 const {d,l}=await delegated(env,actor,text(v.delegationId,'delegationId')),kind=choice(v.kind,['pickup','park','transfer','callback'],'kind'),key=text(v.idempotencyKey,'idempotencyKey',100),revision=integer(v.lineRevision,'lineRevision',1)
 const auditActor=await actorRef(env.DB,actor.operator.id),principal=await actorRef(env.DB,l.principal_id),operation=id()
 const refused=async(code:string,status=403)=>{await append(env,auditActor,'frontdesk.'+kind,operation,'refused',[],principal);throw new Fault(code,status)}
 if(l.revision!==revision)return refused('line_version_conflict',409)
 const policy=linePolicy(l)
 if(policy.dnd||!policy.withinHours||policy.forwardTo)return refused(policy.dnd?'executive_dnd':!policy.withinHours?'executive_outside_hours':'executive_forwarding_active')
 const target=v.target?text(v.target,'target'):null,callId=v.callId?text(v.callId,'callId'):null
 if(kind==='callback'&&(!target||!/^\+[1-9]\d{7,14}$/.test(target)))throw new Fault('invalid_callback_destination')
 if(kind==='transfer'&&(!target||!/^\+[1-9]\d{7,14}$/.test(target)))throw new Fault('invalid_transfer_destination')
 if(kind!=='callback'){
  if(!callId)return refused('call_required')
  const call=await sql(env,`SELECT r.id FROM hnd_records r JOIN hnd_record_sources rs ON rs.record_id=r.id WHERE r.id=? AND rs.source_id=? AND r.kind='call_session'`,callId,l.source_id).first()
  if(!call)return refused('call_out_of_scope')
 }
 const prior=await sql(env,'SELECT * FROM hnd_frontdesk_operations WHERE delegation_id=? AND idempotency_key=?',d.id,key).first<{id:string;kind:string;call_id:string|null;target:string|null;line_revision:number}>()
 if(prior){if(prior.kind!==kind||prior.call_id!==callId||prior.target!==target||prior.line_revision!==revision)throw new Fault('idempotency_state_changed',409);return {operation:prior,replay:true,effectOccurred:false}}
 await append(env,auditActor,'frontdesk.'+kind,operation,'uncertain',[nativeFence(env,actor),delegationFence(env,actor,d,l),sql(env,"INSERT INTO hnd_frontdesk_operations VALUES (?,?,?,?,?,?,?,?,?,'held',?)",operation,d.id,auditActor,principal,kind,callId,target,revision,key,Date.now())],principal)
 return {operation:{id:operation,kind,actor:auditActor,principal,state:'held',fromNumberId:l.number_id},effectOccurred:false,reason:'qualified_media_endpoint_and_exact_spend_approval_required',replay:false}
}
