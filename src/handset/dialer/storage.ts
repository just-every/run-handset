import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { append, commit } from '../audit/store'
import { Fault, id } from '../core'
import type { Attempt, List, Qualification, Recipient, Run } from './model'
export type Context={env:Bindings;actor?:Session;auditActor?:string}
export const sql=(ctx:Context,query:string,...values:(string|number|null)[])=>ctx.env.DB.prepare(query).bind(...values)
export const guard=(ctx:Context,query:string,...values:(string|number|null)[])=>sql(ctx,'INSERT INTO hnd_guard(ok) '+query,...values)
export function event(ctx:Context,type:string,listId:string|null,sessionId:string|null,attemptId:string|null,payload:unknown={}){return sql(ctx,'INSERT INTO hnd_dialer_events(id,session_id,list_id,attempt_id,actor,type,occurred_at,payload) VALUES (?,?,?,?,?,?,?,?)',id(),sessionId,listId,attemptId,ctx.actor?.operator.id??ctx.auditActor??'dialer',type,Date.now(),JSON.stringify(payload))}
export async function write(ctx:Context,subject:string,statements:D1PreparedStatement[]){if(ctx.actor)return commit(ctx.env,ctx.actor,'product.request',subject,'completed',statements);if(ctx.auditActor)return append(ctx.env,ctx.auditActor,'product.request',subject,'completed',statements);throw new Fault('dialer_writer_required',403)}
async function requireRow<T>(ctx:Context,table:string,id:string):Promise<T>{const row=await sql(ctx,'SELECT * FROM '+table+' WHERE id=?',id).first<T>();if(!row)throw new Fault('dialer_record_not_found',404);return row}
export const list=(ctx:Context,id:string)=>requireRow<List>(ctx,'hnd_dialer_lists',id)
export const run=(ctx:Context,id:string)=>requireRow<Run>(ctx,'hnd_dialer_sessions',id)
export const attempt=(ctx:Context,id:string)=>requireRow<Attempt>(ctx,'hnd_dialer_attempts',id)
export const qualification=(ctx:Context,id:string)=>requireRow<Qualification>(ctx,'hnd_dialer_qualifications',id)
export const recipients=async(ctx:Context,listId:string)=>(await sql(ctx,'SELECT * FROM hnd_dialer_recipients WHERE list_id=? ORDER BY ordinal',listId).all<Recipient>()).results
export async function evidence(ctx:Context,recordId:string){const r=await sql(ctx,"SELECT id FROM hnd_records WHERE id=? AND kind IN ('comment','consent') AND supersedes_id IS NULL AND NOT EXISTS(SELECT 1 FROM hnd_records r WHERE r.supersedes_id=hnd_records.id)",recordId).first();if(!r)throw new Fault('current_native_evidence_required',409);return guard(ctx,'SELECT count(*) FROM hnd_records WHERE id=? AND NOT EXISTS(SELECT 1 FROM hnd_records r WHERE r.supersedes_id=hnd_records.id)',recordId)}
export const currentOwner=async(ctx:Context,id:string,version:number)=>Boolean(await sql(ctx,"SELECT id FROM oa_operators WHERE id=? AND version=? AND status='active' AND role='owner'",id,version).first())
export const ownerGuard=(ctx:Context,id:string,version:number)=>guard(ctx,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active' AND role='owner'",id,version)
