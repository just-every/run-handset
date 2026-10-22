import { Fault, id, integer, keys, text, type ObjectValue } from '../core'
import { entry, entryGuard, event, guard, queue, statement, write, type Context } from './storage'
import { language, list, strings, type Entry, type Queue, type Reservation } from './model'
import { newVisit, visitState } from './visits'

export async function enqueue(ctx:Context,queueId:string,value:ObjectValue){
 keys(value,['callId','language','skills','priority'])
 const q=await queue(ctx,queueId),callId=text(value.callId,'callId'),lang=language(value.language??'en'),skills=JSON.stringify(list(value.skills??[],'skills')),priority=integer(value.priority??0,'priority',0,100)
 const call=await statement(ctx,"SELECT data FROM hnd_records WHERE id=? AND kind='call_session'",callId).first<{data:string}>()
 if(!call||JSON.parse(call.data).direction!=='inbound')throw new Fault('inbound_call_record_required')
 const existing=await statement(ctx,'SELECT * FROM hnd_queue_entries WHERE call_id=?',callId).first<Entry>()
 if(existing){
  if(existing.origin_queue_id!==q.id||existing.language!==lang||existing.skills!==skills||existing.priority!==priority)throw new Fault('queue_admission_conflict',409)
  return {entry:existing,replay:true}
 }
 const now=Date.now(),target=id(),visitId=id()
 await write(ctx,target,[
  guard(ctx,'SELECT count(*) FROM hnd_queues WHERE id=? AND revision=?',q.id,q.revision),
  // Bounded admission counts every native assignment, rather than reading a
  // caller-supplied capacity or inventing available media legs.
  guard(ctx,"SELECT CASE WHEN count(*)<? THEN 1 ELSE 0 END FROM hnd_queue_entries WHERE queue_id=? AND state IN ('waiting','reserved')",q.max_waiting,q.id),
  statement(ctx,`INSERT INTO hnd_queue_entries(id,queue_id,origin_queue_id,call_id,language,skills,priority,state,created_at,queued_at,deadline_at,visited) VALUES (?,?,?,?,?,?,?,'waiting',?,?,?,?)`,target,q.id,q.id,callId,lang,skills,priority,now,now,now+q.max_wait_seconds*1000,JSON.stringify([q.id])),
  newVisit(ctx,visitId,target,q.id,1,now),
  statement(ctx,'UPDATE hnd_queue_entries SET current_visit_id=? WHERE id=?',visitId,target),
  event(ctx,'entry.admitted',q.id,target,null,{priority,language:lang,deadlineAt:now+q.max_wait_seconds*1000}),
 ])
 return {entry:await entry(ctx,target),replay:false}
}
export async function overflow(ctx:Context,row:Entry,q:Queue,reason:string,now=Date.now()){
 const offered=await statement(ctx,"SELECT id FROM hnd_queue_offers WHERE visit_id=? AND state IN ('uncertain','ringing','active')",row.current_visit_id).first()
 if(offered)throw new Fault('provider_offer_unresolved',409)
 const next=q.overflow_kind==='queue'&&q.overflow_queue_id?await queue(ctx,q.overflow_queue_id):null
 if(next){
  if(strings(row.visited).includes(next.id))throw new Fault('overflow_cycle',409)
  const full=await statement(ctx,"SELECT count(*) AS n FROM hnd_queue_entries WHERE queue_id=? AND state IN ('waiting','reserved')",next.id).first<{n:number}>()
  // Do not invent a voicemail choice when the reviewed destination is full.
  // Retain a terminal decision for the exact selected queue, visibly pending.
  if((full?.n??0)>=next.max_waiting)return terminalOverflow(ctx,row,q,'overflow_queue_full',now)
  const visitId=id()
  await write(ctx,row.id,[entryGuard(ctx,row),
   guard(ctx,'SELECT count(*) FROM hnd_queues WHERE id=? AND revision=?',q.id,q.revision),
   guard(ctx,'SELECT count(*) FROM hnd_queues WHERE id=? AND revision=?',next.id,next.revision),
   guard(ctx,"SELECT CASE WHEN count(*)<? THEN 1 ELSE 0 END FROM hnd_queue_entries WHERE queue_id=? AND state IN ('waiting','reserved')",next.max_waiting,next.id),
   statement(ctx,'DELETE FROM hnd_queue_reservations WHERE entry_id=?',row.id),
   visitState(ctx,row,'overflow',now,true,reason),
   newVisit(ctx,visitId,row.id,next.id,strings(row.visited).length+1,now),
   statement(ctx,"UPDATE hnd_queue_entries SET queue_id=?,state='waiting',agent_id=NULL,reserved_at=NULL,queued_at=?,deadline_at=?,visited=?,reason=?,current_visit_id=?,revision=revision+1 WHERE id=?",next.id,now,now+next.max_wait_seconds*1000,JSON.stringify([...strings(row.visited),next.id]),reason,visitId,row.id),
   event(ctx,'entry.overflow',q.id,row.id,row.agent_id,{reason,destinationKind:'queue',destinationQueueId:next.id,deadlineAt:row.deadline_at,observedDelayMs:Math.max(0,now-row.deadline_at)},now),
   event(ctx,'entry.transferred',next.id,row.id,null,{fromQueueId:q.id,deadlineAt:now+next.max_wait_seconds*1000},now),
  ])
 }else await terminalOverflow(ctx,row,q,reason,now)
 return entry(ctx,row.id)
}
async function terminalOverflow(ctx:Context,row:Entry,q:Queue,reason:string,now:number){
 await write(ctx,row.id,[entryGuard(ctx,row),guard(ctx,'SELECT count(*) FROM hnd_queues WHERE id=? AND revision=?',q.id,q.revision),
  statement(ctx,'DELETE FROM hnd_queue_reservations WHERE entry_id=?',row.id),
  statement(ctx,"UPDATE hnd_queue_entries SET state='overflow',agent_id=NULL,overflow_kind=?,reason=?,ended_at=?,revision=revision+1 WHERE id=?",q.overflow_kind,reason,now,row.id),
  event(ctx,'entry.overflow',q.id,row.id,row.agent_id,{reason,destinationKind:q.overflow_kind,destinationQueueId:q.overflow_queue_id,deadlineAt:row.deadline_at,observedDelayMs:Math.max(0,now-row.deadline_at),delivery:'pending'},now),
 ])
 return entry(ctx,row.id)
}
export async function entryAction(ctx:Context,entryId:string,action:string,value:ObjectValue){
 keys(value,['revision'])
 const row=await entry(ctx,entryId),expected=integer(value.revision,'revision',1),now=Date.now()
 if(expected!==row.revision)throw new Fault('entry_revision_conflict',409,{current:row})
 const q=await queue(ctx,row.queue_id),statements=[entryGuard(ctx,row)]
 const liveOffer=await statement(ctx,"SELECT id FROM hnd_queue_offers WHERE entry_id=? AND state IN ('uncertain','ringing','active') LIMIT 1",row.id).first()
 if(liveOffer)throw new Fault('provider_offer_requires_readback',409)
 if(action==='accept'){
  if(row.state!=='reserved')throw new Fault('entry_not_reserved',409)
  const providerBinding=await statement(ctx,'SELECT b.id FROM hnd_record_sources r JOIN hnd_queue_bindings b ON b.source_id=r.source_id WHERE r.record_id=? LIMIT 1',row.call_id).first()
  if(providerBinding)throw new Fault('carrier_bridge_unqualified',409)
  const reservation=await statement(ctx,'SELECT * FROM hnd_queue_reservations WHERE entry_id=?',row.id).first<Reservation>()
  if(!reservation||reservation.lease_until<=now||row.deadline_at<=now)throw new Fault('reservation_expired',409)
  statements.push(guard(ctx,"SELECT count(*) FROM hnd_queue_reservations WHERE entry_id=? AND state='reserved' AND lease_until>?",row.id,now),
   statement(ctx,"UPDATE hnd_queue_entries SET state='active',accepted_at=?,revision=revision+1 WHERE id=?",now,row.id),
   statement(ctx,"UPDATE hnd_queue_reservations SET state='active' WHERE entry_id=?",row.id),
   event(ctx,'entry.accepted',q.id,row.id,row.agent_id,{meaning:'native assignment accepted; media unverified'},now))
 }else if(action==='complete'||action==='abandon'){
  if(action==='complete'&&row.state!=='active')throw new Fault('entry_not_active',409)
  if(!['waiting','reserved','active'].includes(row.state))throw new Fault('entry_already_terminal',409)
  statements.push(statement(ctx,'DELETE FROM hnd_queue_reservations WHERE entry_id=?',row.id),
   statement(ctx,'UPDATE hnd_queue_entries SET state=?,ended_at=?,reason=?,revision=revision+1 WHERE id=?',action==='complete'?'completed':'abandoned',now,action==='complete'?(ctx.actor?'owner_reported_completion':'provider_reported_completion'):(ctx.actor?'owner_reported_abandon':'provider_reported_abandon'),row.id))
  if(row.agent_id){
   statements.push(statement(ctx,'UPDATE hnd_queue_agents SET idle_since=?,wrap_until=CASE WHEN wrap_until>? THEN wrap_until ELSE ? END,revision=revision+1 WHERE operator_id=?',now,row.state==='active'?now+q.wrap_seconds*1000:0,row.state==='active'?now+q.wrap_seconds*1000:0,row.agent_id))
  }
  statements.push(event(ctx,action==='complete'?'entry.completed':'entry.abandoned',q.id,row.id,row.agent_id,{observation:ctx.observation??'owner reported',wrapUntil:row.agent_id&&row.state==='active'?now+q.wrap_seconds*1000:null},now))
 }else throw new Fault('invalid_entry_action')
 await write(ctx,row.id,statements);return entry(ctx,row.id)
}
