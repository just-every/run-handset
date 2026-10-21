import { Fault } from '../core'
import { presenceFreshMs } from '../queues/model'
import { waitingAgent } from './network'
import { guard, sql, type Context } from './storage'
import type { List, QualificationDefinition, Ready } from './model'
// Shared by the read and atomic admission fence. Only current, suitable native
// queue staff count, with actual occupied slots subtracted from both workloads.
const staffSql=`FROM hnd_queue_agents a JOIN hnd_queue_memberships m ON m.operator_id=a.operator_id JOIN oa_operators o ON o.id=a.operator_id JOIN hnd_queues q ON q.id=m.queue_id WHERE m.queue_id=? AND m.logged_in=1 AND o.status='active' AND a.availability='available' AND a.heartbeat_at>? AND a.wrap_until<=? AND NOT EXISTS(SELECT 1 FROM json_each(q.skills) s WHERE NOT EXISTS(SELECT 1 FROM json_each(a.skills) x WHERE x.value=s.value)) AND EXISTS(SELECT 1 FROM json_each(a.languages) WHERE value='en')`
const freeSql=`SELECT COALESCE(sum(max(0,a.capacity-(SELECT count(*) FROM hnd_queue_reservations r WHERE r.agent_id=a.operator_id)-(SELECT count(*) FROM hnd_dialer_reservations r WHERE r.agent_id=a.operator_id))),0) AS n ${staffSql}`
export async function capacity(ctx:Context,l:List,policy:QualificationDefinition){
 const now=Date.now(),q=await sql(ctx,'SELECT max_waiting FROM hnd_queues WHERE id=?',l.queue_id).first<{max_waiting:number}>();if(!q)throw new Fault('queue_not_found',404)
 const waiting=await sql(ctx,"SELECT count(*) AS n,min(queued_at) AS oldest FROM hnd_queue_entries WHERE queue_id=? AND state IN ('waiting','reserved')",l.queue_id).first<{n:number;oldest:number|null}>()
 if(waiting&&(waiting.n>=q.max_waiting||waiting.oldest!==null&&waiting.oldest<=now-policy.breachSeconds*1000))throw new Fault('inbound_service_breach',409)
 const free=(await sql(ctx,freeSql,l.queue_id,now-presenceFreshMs,now).first<{n:number}>())?.n??0,reserve=policy.inboundReserve+(waiting?.n??0)
 if(free<=reserve)throw new Fault('inbound_staff_reserve',409)
 const staff=(await sql(ctx,'SELECT a.operator_id,a.capacity,a.revision '+staffSql,l.queue_id,now-presenceFreshMs,now).all<{operator_id:string;capacity:number;revision:number}>()).results
 const occupied=(await sql(ctx,'SELECT agent_id,slot FROM hnd_queue_reservations UNION ALL SELECT agent_id,slot FROM hnd_dialer_reservations').all<{agent_id:string;slot:number}>()).results
 const candidates=[]
 for(const agent of staff){
  if(occupied.some(r=>r.agent_id===agent.operator_id))continue
  const ready=await sql(ctx,`SELECT r.* FROM hnd_dialer_ready r JOIN oa_operators o ON o.id=r.approved_by WHERE r.agent_id=? AND r.source_id=? AND r.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=r.owner_version`,agent.operator_id,l.source_id,now).first<Ready>()
  const route=await sql(ctx,`SELECT r.* FROM hnd_queue_agent_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.operator_id=? AND r.source_id=? AND r.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=r.owner_version`,agent.operator_id,l.source_id).first<{destination:string;revision:number}>()
  if(ready&&route)candidates.push({agent,ready,route,slot:1})
 }
 return {free,reserve,available:free-reserve,candidates,now}
}
export async function reserveCandidate(ctx:Context,l:List,account:string,policy:QualificationDefinition){
 const c=await capacity(ctx,l,policy),selected=c.candidates[0]
 if(!selected)throw new Fault('waiting_agent_required',409)
 await waitingAgent(ctx,account,selected.ready,selected.route.destination)
 const now=Date.now(),{agent,ready,route,slot}=selected
 const fences=[
  guard(ctx,'SELECT CASE WHEN ('+freeSql+')>?+(SELECT count(*) FROM hnd_queue_entries WHERE queue_id=? AND state IN (\'waiting\',\'reserved\')) THEN 1 ELSE 0 END',l.queue_id,now-presenceFreshMs,now,policy.inboundReserve,l.queue_id),
  guard(ctx,"SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_queue_entries WHERE queue_id=? AND state IN ('waiting','reserved') AND queued_at<=?) OR (SELECT count(*) FROM hnd_queue_entries WHERE queue_id=? AND state IN ('waiting','reserved'))>=(SELECT max_waiting FROM hnd_queues WHERE id=?) THEN 0 ELSE 1 END",l.queue_id,now-policy.breachSeconds*1000,l.queue_id,l.queue_id),
  guard(ctx,"SELECT count(*) FROM hnd_queue_agents a JOIN hnd_queue_memberships m ON m.operator_id=a.operator_id JOIN oa_operators o ON o.id=a.operator_id WHERE a.operator_id=? AND a.revision=? AND a.availability='available' AND a.heartbeat_at>? AND a.wrap_until<=? AND m.queue_id=? AND m.logged_in=1 AND o.status='active'",agent.operator_id,agent.revision,now-presenceFreshMs,now,l.queue_id),
  guard(ctx,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_queue_reservations WHERE agent_id=?) OR EXISTS(SELECT 1 FROM hnd_dialer_reservations WHERE agent_id=?) THEN 0 ELSE 1 END',agent.operator_id,agent.operator_id),
  guard(ctx,'SELECT count(*) FROM hnd_dialer_ready r JOIN oa_operators o ON o.id=r.approved_by WHERE r.agent_id=? AND r.conference_sid=? AND r.agent_call_sid=? AND r.expires_at>? AND o.status=\'active\' AND o.role=\'owner\' AND o.version=r.owner_version',agent.operator_id,ready.conference_sid,ready.agent_call_sid,now),
  guard(ctx,'SELECT count(*) FROM hnd_queue_agent_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.operator_id=? AND r.source_id=? AND r.revision=? AND r.revoked_at IS NULL AND o.status=\'active\' AND o.role=\'owner\' AND o.version=r.owner_version',agent.operator_id,l.source_id,route.revision),
 ]
 return {...selected,fences}
}
