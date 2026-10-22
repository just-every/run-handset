import { Fault } from '../core'
import { entryGuard, event, guard, queue, statement, write, type Context } from './storage'
import { overflow } from './entries'
import { currentOffer } from './offers'
import { recoverOffer } from './offer-readback'
import { matches, presenceFreshMs, reservationLeaseMs, type Agent, type Entry, type Membership, type Queue, type Reservation } from './model'

export async function reconcile(ctx:Context,queueId?:string){
 const now=Date.now(),expired=(await statement(ctx,`SELECT e.* FROM hnd_queue_entries e WHERE e.state IN ('waiting','reserved') ${queueId?'AND e.queue_id=?':''} ORDER BY e.deadline_at,e.id LIMIT 1000`,...(queueId?[queueId]:[])).all<Entry>()).results
 const active=(await statement(ctx,`SELECT o.* FROM hnd_queue_offers o WHERE o.state='active' ${queueId?'AND o.queue_id=?':''} ORDER BY o.emitted_at LIMIT 1000`,...(queueId?[queueId]:[])).all<import('./offers').Offer>()).results
 for(const offer of active)await recoverOffer(ctx,offer)
 let overflows=0,released=0
 for(const row of expired){
  const offer=await currentOffer(ctx,row)
  if(offer&&['uncertain','ringing','active'].includes(offer.state)){await recoverOffer(ctx,offer);continue}
  if(row.deadline_at<=now){await overflow(ctx,row,await queue(ctx,row.queue_id),'maximum_wait',now);overflows++;continue}
  if(row.state==='reserved'){
   const lease=await statement(ctx,'SELECT * FROM hnd_queue_reservations WHERE entry_id=?',row.id).first<Reservation>()
   if(!lease)throw new Fault('reservation_state_inconsistent',409)
   if(lease.state==='reserved'&&lease.lease_until<=now){
    await write(ctx,row.id,[entryGuard(ctx,row),
     guard(ctx,"SELECT count(*) FROM hnd_queue_reservations WHERE entry_id=? AND state='reserved' AND lease_until<=?",row.id,now),
     statement(ctx,'DELETE FROM hnd_queue_reservations WHERE entry_id=?',row.id),
     statement(ctx,"UPDATE hnd_queue_entries SET state='waiting',agent_id=NULL,reserved_at=NULL,reason='reservation_expired',revision=revision+1 WHERE id=?",row.id),
     event(ctx,'reservation.released',row.queue_id,row.id,row.agent_id,{reason:'lease expired; no carrier dial was attempted'},now)])
    released++
   }
  }
 }
 // Active assignments have no timeout. A process restart cannot prove that an
 // actual call ended; only explicit observation releases their occupied slots.
 return {overflows,released,activeAssignmentsPreserved:true}
}
async function roster(ctx:Context,q:Queue){
 return (await statement(ctx,`SELECT a.*,m.priority AS membership_priority,m.revision AS membership_revision FROM hnd_queue_agents a JOIN hnd_queue_memberships m ON m.operator_id=a.operator_id JOIN oa_operators o ON o.id=a.operator_id WHERE m.queue_id=? AND m.logged_in=1 AND o.status='active'`,q.id).all<Agent&{membership_priority:number;membership_revision:number}>()).results
}
export async function dispatch(ctx:Context,queueId:string){
 const q=await queue(ctx,queueId),recovery=await reconcile(ctx,q.id),now=Date.now()
 const waiting=(await statement(ctx,"SELECT * FROM hnd_queue_entries WHERE queue_id=? AND state='waiting' ORDER BY priority DESC,queued_at,created_at,id LIMIT 1000",q.id).all<Entry>()).results
 const assigned:string[]=[],overflowed:string[]=[]
 for(const row of waiting){
  let staff=(await roster(ctx,q)).filter(a=>matches(a,row,q)&&a.heartbeat_at>now-presenceFreshMs&&['available','busy'].includes(a.availability))
  const source=await statement(ctx,'SELECT source_id FROM hnd_record_sources WHERE record_id=?',row.call_id).first<{source_id:string}>()
  if(source){
   const routes=(await statement(ctx,`SELECT r.operator_id FROM hnd_queue_agent_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.source_id=? AND r.revoked_at IS NULL AND o.status='active' AND o.role='owner'`,source.source_id).all<{operator_id:string}>()).results
   staff=staff.filter(a=>routes.some(r=>r.operator_id===a.operator_id))
  }
  if(!staff.length){await overflow(ctx,row,q,'no_eligible_agent',now);overflowed.push(row.id);continue}
  const occupied=(await statement(ctx,'SELECT agent_id,slot FROM hnd_queue_reservations UNION SELECT agent_id,slot FROM hnd_dialer_reservations').all<{agent_id:string;slot:number}>()).results
  const candidates=staff.filter(a=>a.availability==='available'&&a.wrap_until<=now).map(a=>({agent:a,slot:Array.from({length:a.capacity},(_,i)=>i+1).find(slot=>!occupied.some(r=>r.agent_id===a.operator_id&&r.slot===slot))})).filter((v):v is {agent:typeof staff[number];slot:number}=>v.slot!==undefined)
  candidates.sort((a,b)=>b.agent.membership_priority-a.agent.membership_priority||
   (q.mode==='round_robin'?a.agent.last_assignment_at-b.agent.last_assignment_at:a.agent.idle_since-b.agent.idle_since)||a.agent.operator_id.localeCompare(b.agent.operator_id))
  const selected=candidates[0]
  if(!selected)continue
  const {agent:a,slot}=selected
  const claimNow=Date.now()
  if(row.deadline_at<=claimNow){await overflow(ctx,row,q,'maximum_wait',claimNow);overflowed.push(row.id);continue}
  await write(ctx,row.id,[entryGuard(ctx,row),
   guard(ctx,'SELECT count(*) FROM hnd_queues WHERE id=? AND revision=?',q.id,q.revision),
   guard(ctx,`SELECT count(*) FROM hnd_queue_agents a JOIN hnd_queue_memberships m ON m.operator_id=a.operator_id JOIN oa_operators o ON o.id=a.operator_id WHERE a.operator_id=? AND a.revision=? AND a.availability='available' AND a.heartbeat_at>? AND a.wrap_until<=? AND a.capacity>=? AND m.queue_id=? AND m.logged_in=1 AND m.revision=? AND o.status='active'`,a.operator_id,a.revision,claimNow-presenceFreshMs,claimNow,slot,q.id,a.membership_revision),
   guard(ctx,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_queue_reservations WHERE agent_id=? AND slot=?) THEN 0 ELSE 1 END',a.operator_id,slot),
   statement(ctx,"INSERT INTO hnd_queue_reservations VALUES (?,?,?,?,'reserved')",row.id,a.operator_id,slot,claimNow+reservationLeaseMs),
   statement(ctx,"UPDATE hnd_queue_entries SET state='reserved',agent_id=?,reserved_at=?,reason='',revision=revision+1 WHERE id=?",a.operator_id,claimNow,row.id),
   statement(ctx,'UPDATE hnd_queue_agents SET last_assignment_at=?,idle_since=?,revision=revision+1 WHERE operator_id=?',claimNow,claimNow,a.operator_id),
   event(ctx,'entry.reserved',q.id,row.id,a.operator_id,{slot,leaseUntil:claimNow+reservationLeaseMs,deadlineAt:row.deadline_at},claimNow),
  ])
  assigned.push(row.id)
 }
 return {...recovery,assigned,overflowed,transport:'unknown'}
}
