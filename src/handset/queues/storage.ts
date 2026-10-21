import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { append, commit } from '../audit/store'
import { Fault, id } from '../core'
import type { Agent, Entry, Queue } from './model'

export type Context={env:Bindings;actor?:Session;auditActor?:string;fences?:()=>D1PreparedStatement[];observation?:string}
export type OwnerContext=Context&{actor:Session}
export const statement=(ctx:Context,sql:string,...values:(string|number|null)[])=>ctx.env.DB.prepare(sql).bind(...values)
export const guard=(ctx:Context,sql:string,...values:(string|number|null)[])=>statement(ctx,'INSERT INTO hnd_guard(ok) '+sql,...values)
export function event(ctx:Context,type:string,queueId:string|null,entryId:string|null,agentId:string|null,payload:Record<string,unknown>={},at=Date.now()){
 return statement(ctx,'INSERT INTO hnd_queue_events(id,queue_id,entry_id,agent_id,type,occurred_at,payload) VALUES (?,?,?,?,?,?,?)',id(),queueId,entryId,agentId,type,at,JSON.stringify({source:'native',transport:'unknown',...payload}))
}
export async function write(ctx:Context,subject:string,statements:D1PreparedStatement[]){
 if(ctx.actor)await commit(ctx.env,ctx.actor,'product.request',subject,'completed',statements)
 else if(ctx.auditActor)await append(ctx.env,ctx.auditActor,'product.request',subject,'completed',[...(ctx.fences?.()??[]),...statements])
 else throw new Fault('queue_writer_authority_required',403)
}
export async function queue(ctx:Context,queueId:string){
 const row=await statement(ctx,'SELECT * FROM hnd_queues WHERE id=?',queueId).first<Queue>()
 if(!row)throw new Fault('queue_not_found',404)
 return row
}
export async function entry(ctx:Context,entryId:string){
 const row=await statement(ctx,'SELECT * FROM hnd_queue_entries WHERE id=?',entryId).first<Entry>()
 if(!row)throw new Fault('queue_entry_not_found',404)
 return row
}
export async function agent(ctx:Context,agentId:string){
 const row=await statement(ctx,'SELECT * FROM hnd_queue_agents WHERE operator_id=?',agentId).first<Agent>()
 if(!row)throw new Fault('queue_agent_not_found',404)
 return row
}
export const entryGuard=(ctx:Context,row:Entry)=>guard(ctx,'SELECT count(*) FROM hnd_queue_entries WHERE id=? AND revision=?',row.id,row.revision)
