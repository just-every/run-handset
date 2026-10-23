import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { append, commit } from '../audit/store'
import type { AppliedPolicy } from '../audit/policy'
import { Fault, id } from '../core'
import type { Attempt, List, Qualification, Recipient, Run } from './model'
export type Context={env:Bindings;actor?:Session;auditActor?:string;requiredAgentId?:string;maxCallSeconds?:number;fences?:()=>D1PreparedStatement[];applied?:AppliedPolicy}
export const sql=(ctx:Context,query:string,...values:(string|number|null)[])=>ctx.env.DB.prepare(query).bind(...values)
export const guard=(ctx:Context,query:string,...values:(string|number|null)[])=>sql(ctx,'INSERT INTO hnd_guard(ok) '+query,...values)
export function event(ctx:Context,type:string,listId:string|null,sessionId:string|null,attemptId:string|null,payload:unknown={}){return sql(ctx,'INSERT INTO hnd_dialer_events(id,session_id,list_id,attempt_id,actor,type,occurred_at,payload) VALUES (?,?,?,?,?,?,?,?)',id(),sessionId,listId,attemptId,ctx.actor?.operator.id??ctx.auditActor??'dialer',type,Date.now(),JSON.stringify(payload))}
export async function write(ctx:Context,subject:string,statements:D1PreparedStatement[]){statements=[...(ctx.fences?.()??[]),...statements];if(ctx.actor){const a=ctx.actor;return commit(ctx.env,a,'product.request',subject,'completed',[guard(ctx,`SELECT count(*) FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id WHERE s.id=? AND s.operator_id=? AND s.operator_version=o.version AND o.status='active' AND s.revoked_at IS NULL AND s.expires_at>?`,a.id,a.operator.id,Date.now()),...statements],a.operator.role==='owner',ctx.applied)};if(ctx.auditActor)return append(ctx.env,ctx.auditActor,'product.request',subject,'completed',statements,null,ctx.applied);throw new Fault('dialer_writer_required',403)}
export async function listPolicy(ctx:Context,l:List){
 const source=await sql(ctx,'SELECT id,revision,owner_version FROM hnd_sources WHERE id=?',l.source_id).first<{id:string;revision:number;owner_version:number}>()
 const q=await qualification(ctx,l.qualification_id)
 if(!source)throw new Fault('dialer_source_not_found',409)
 const applied:AppliedPolicy={...ctx.applied,source:{id:source.id,revision:source.revision,ownerVersion:source.owner_version},list:{id:l.id,revision:1,ownerVersion:l.owner_version},qualification:{id:q.id,revision:1,ownerVersion:q.owner_version}}
 delete applied.standing
 if(l.policy_id)applied.standing={id:l.policy_id,revision:l.policy_revision!,ownerVersion:l.owner_version}
 // List approvals and qualifications are immutable; revocation never replaces
 // the snapshot that originally authorized an already-started call.
 ctx.applied=applied
 return applied
}
async function requireRow<T>(ctx:Context,table:string,id:string):Promise<T>{const row=await sql(ctx,'SELECT * FROM '+table+' WHERE id=?',id).first<T>();if(!row)throw new Fault('dialer_record_not_found',404);return row}
export const list=(ctx:Context,id:string)=>requireRow<List>(ctx,'hnd_dialer_lists',id)
export const run=(ctx:Context,id:string)=>requireRow<Run>(ctx,'hnd_dialer_sessions',id)
export const attempt=(ctx:Context,id:string)=>requireRow<Attempt>(ctx,'hnd_dialer_attempts',id)
export const qualification=(ctx:Context,id:string)=>requireRow<Qualification>(ctx,'hnd_dialer_qualifications',id)
export const recipients=async(ctx:Context,listId:string)=>(await sql(ctx,'SELECT * FROM hnd_dialer_recipients WHERE list_id=? ORDER BY ordinal',listId).all<Recipient>()).results
export async function evidence(ctx:Context,recordId:string){const r=await sql(ctx,"SELECT id FROM hnd_records WHERE id=? AND kind IN ('comment','consent') AND supersedes_id IS NULL AND NOT EXISTS(SELECT 1 FROM hnd_records r WHERE r.supersedes_id=hnd_records.id)",recordId).first();if(!r)throw new Fault('current_native_evidence_required',409);return guard(ctx,'SELECT count(*) FROM hnd_records WHERE id=? AND NOT EXISTS(SELECT 1 FROM hnd_records r WHERE r.supersedes_id=hnd_records.id)',recordId)}
export const currentOwner=async(ctx:Context,id:string,version:number)=>Boolean(await sql(ctx,"SELECT id FROM oa_operators WHERE id=? AND version=? AND status='active' AND role='owner'",id,version).first())
export const ownerGuard=(ctx:Context,id:string,version:number)=>guard(ctx,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active' AND role='owner'",id,version)
