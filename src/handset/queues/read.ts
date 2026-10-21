import { id } from '../core'
import { entryGuard, event, statement, write, type Context } from './storage'
import { presenceFreshMs, type Agent, type Entry, type Membership, type Queue, type Reservation } from './model'
import { reconcile } from './routing'

export async function announcement(ctx:Context,row:Entry){
 if(!['waiting','reserved'].includes(row.state))return null
 const ordered=(await statement(ctx,"SELECT id FROM hnd_queue_entries WHERE queue_id=? AND state IN ('waiting','reserved') ORDER BY priority DESC,queued_at,created_at,id",row.queue_id).all<{id:string}>()).results
 const position=ordered.findIndex(v=>v.id===row.id)+1
 if(!position)return null
 const existing=await statement(ctx,'SELECT * FROM hnd_queue_announcements WHERE entry_id=? AND entry_revision=? AND position=?',row.id,row.revision,position).first()
 if(existing)return existing
 const spanish=row.language==='es'||row.language.startsWith('es-'),message=spanish?`Su posición en la cola es ${position}. Aún no hay una estimación de espera verificada.`:`Your queue position is ${position}. A verified wait estimate is not yet available.`
 const target=id(),now=Date.now()
 await write(ctx,row.id,[entryGuard(ctx,row),
  statement(ctx,"INSERT INTO hnd_queue_announcements(id,entry_id,entry_revision,position,language,text,estimated_wait_seconds,estimate_basis,created_at) VALUES (?,?,?,?,?,?,NULL,'insufficient_verified_media_samples',?)",target,row.id,row.revision,position,row.language,message,now),
  event(ctx,'announcement.prepared',row.queue_id,row.id,row.agent_id,{announcementId:target,position,language:row.language,delivery:'pending'},now),
 ])
 return (await statement(ctx,'SELECT * FROM hnd_queue_announcements WHERE id=?',target).first())!
}
export async function snapshot(ctx:Context,queueId?:string){
 await reconcile(ctx,queueId)
 const [queues,agents,memberships,entries,reservations,bindings,sources]=await Promise.all([
  statement(ctx,`SELECT * FROM hnd_queues ${queueId?'WHERE id=?':''} ORDER BY name,id`,...(queueId?[queueId]:[])).all<Queue>(),
  statement(ctx,'SELECT a.*,o.display_name,o.status AS operator_status FROM hnd_queue_agents a JOIN oa_operators o ON o.id=a.operator_id ORDER BY o.display_name,a.operator_id').all<Agent&{display_name:string;operator_status:string}>(),
  statement(ctx,`SELECT * FROM hnd_queue_memberships ${queueId?'WHERE queue_id=?':''} ORDER BY queue_id,operator_id`,...(queueId?[queueId]:[])).all<Membership>(),
  statement(ctx,`SELECT * FROM hnd_queue_entries ${queueId?'WHERE queue_id=?':''} ORDER BY created_at DESC,id LIMIT 1001`,...(queueId?[queueId]:[])).all<Entry>(),
  statement(ctx,'SELECT * FROM hnd_queue_reservations').all<Reservation>(),
  statement(ctx,'SELECT id,source_id,queue_id,language,spanish_digit,revoked_at FROM hnd_queue_bindings ORDER BY created_at,id').all<{id:string;source_id:string;queue_id:string;language:string;spanish_digit:string;revoked_at:number|null}>(),
  statement(ctx,'SELECT id,account_id,revoked_at FROM hnd_sources ORDER BY created_at,id').all<{id:string;account_id:string;revoked_at:number|null}>(),
 ])
 const pending=entries.results.filter(row=>['waiting','reserved'].includes(row.state)),announcements=[]
 for(const row of pending){const item=await announcement(ctx,row);if(item)announcements.push(item)}
 const now=Date.now(),counts=(await statement(ctx,`SELECT queue_id,state,count(*) AS count FROM hnd_queue_entries ${queueId?'WHERE queue_id=?':''} GROUP BY queue_id,state`,...(queueId?[queueId]:[])).all<{queue_id:string;state:string;count:number}>()).results
 return {
  queues:queues.results,agents:agents.results.map(a=>({...a,presenceFresh:a.heartbeat_at>now-presenceFreshMs,wrapping:a.wrap_until>now})),
  memberships:memberships.results,entries:entries.results.slice(0,1000),limited:entries.results.length>1000,reservations:reservations.results,announcements,
  bindings:bindings.results,sources:sources.results,counts,observedAt:now,transport:'unknown',countsMeaning:'Native queue entries and occupied assignment slots; actual media legs are unverified.',
  gaps:['Carrier agent dialing and bridge are unqualified.','Announcement audio and overflow destination delivery are unconfirmed.'],
 }
}
export async function events(ctx:Context,after:number,queueId?:string){
 const rows=await statement(ctx,`SELECT * FROM hnd_queue_events WHERE sequence>? ${queueId?'AND queue_id=?':''} ORDER BY sequence LIMIT 201`,after,...(queueId?[queueId]:[])).all<{sequence:number;id:string;queue_id:string|null;entry_id:string|null;agent_id:string|null;type:string;occurred_at:number;payload:string}>()
 const page=rows.results.slice(0,200)
 return {events:page.map(row=>({...row,payload:JSON.parse(row.payload)})),nextCursor:page.at(-1)?.sequence??after,hasMore:rows.results.length>200,source:'native',transport:'unknown'}
}
