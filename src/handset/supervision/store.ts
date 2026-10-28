import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { actorRef, commit } from '../audit/store'
import { choice, Fault, id, integer, keys, text, type ObjectValue } from '../core'
import { calculate } from '../metrics/formulas'
import { parseEntry, parseSegment, type Entry as MetricEntry, type Segment } from '../metrics/model'
import { currentConfig } from '../metrics/store'
import { presenceFreshMs, type Agent, type Queue } from '../queues/model'
import { event } from '../queues/storage'
import { active, authorize, nativeFence, ownerActive, scopeFence, sharedScopeSql, validGrantSql } from './authority'
import { operations, refreshAfterMs, staleAfterMs, type Context, type Overview, type TimelineEvent } from './model'

export async function supervisionOverview(env:Bindings,actor:Session):Promise<Overview>{
 const ctx={env,actor};await active(ctx)
 const grants=(await env.DB.prepare(`SELECT g.*,q.name FROM (${validGrantSql.replace(' AND g.queue_id=?','')}) g JOIN hnd_queues q ON q.id=g.queue_id ORDER BY q.name,g.created_at DESC`)
  .bind(actor.operator.id,Date.now()).all<{id:string;queue_id:string;name:string;can_intervene:number;expires_at:number}>()).results
 const queues=[...new Set(grants.map(g=>g.queue_id))].map(queueId=>{
  const scopes=grants.filter(g=>g.queue_id===queueId)
  return {id:queueId,name:scopes[0].name,canIntervene:scopes.some(g=>g.can_intervene===1),expiresAt:Math.max(...scopes.map(g=>g.expires_at))}
 })
 let administration:Pick<Overview,'grants'|'queuesAvailableForGrant'|'people'>={}
 if(actor.operator.role==='owner'){
  await ownerActive(ctx)
  const [allGrants,allQueues,people]=await Promise.all([
   env.DB.prepare(`SELECT g.*,subject.display_name AS operator_name,issuer.display_name AS issuer_name,q.name AS queue_name,
    CASE WHEN g.revoked_at IS NULL AND g.expires_at>? AND subject.status='active' AND subject.version=g.operator_version
    AND issuer.status='active' AND issuer.role='owner' AND issuer.version=g.issuer_version THEN 1 ELSE 0 END AS current
    FROM hnd_supervision_grants g JOIN oa_operators subject ON subject.id=g.operator_id
    JOIN oa_operators issuer ON issuer.id=g.issued_by JOIN hnd_queues q ON q.id=g.queue_id ORDER BY g.created_at DESC,g.id`).bind(Date.now()).all<NonNullable<Overview['grants']>[number]>(),
   env.DB.prepare('SELECT id,name FROM hnd_queues ORDER BY name,id').all<{id:string;name:string}>(),
   env.DB.prepare("SELECT id,display_name FROM oa_operators WHERE status='active' ORDER BY display_name,id").all<{id:string;display_name:string}>(),
  ])
  administration={grants:allGrants.results,queuesAvailableForGrant:allQueues.results,people:people.results}
 }
 await active(ctx)
 return {queues,...administration,refreshAfterMs,staleAfterMs}
}

async function scopedMetrics(ctx:Context,queueId:string){
 const config=await currentConfig(ctx.env.DB,queueId)
 // Extract only the selected queue; never load liveReport's caller records or
 // whole mixed-team dataset blobs into the supervisor read path.
 const [entryRows,segmentRows]=await Promise.all([
  ctx.env.DB.prepare(`SELECT e.value FROM hnd_metric_datasets d,json_each(d.value,'$.entries') e WHERE json_extract(e.value,'$.queueId')=?`).bind(queueId).all<{value:string}>(),
  ctx.env.DB.prepare(`SELECT s.value FROM hnd_metric_datasets d,json_each(d.value,'$.agents') s WHERE json_extract(s.value,'$.agentId') IN (
   SELECT operator_id FROM hnd_queue_memberships WHERE queue_id=? UNION
   SELECT json_extract(e.value,'$.agentId') FROM hnd_metric_datasets source,json_each(source.value,'$.entries') e WHERE json_extract(e.value,'$.queueId')=?
  )`).bind(queueId,queueId).all<{value:string}>(),
 ])
 const unique=<T extends {id:string}>(rows:{value:string}[],parse:(value:unknown)=>T)=>{
  const values=new Map<string,T>()
  for(const row of rows){const item=parse(JSON.parse(row.value)),prior=values.get(item.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(item))throw new Fault('supervision_metric_source_conflict',409);values.set(item.id,item)}
  return [...values.values()]
 }
 const entries=unique<MetricEntry>(entryRows.results,parseEntry),segments=unique<Segment>(segmentRows.results,parseSegment)
 const {callbackParents:_,...metrics}=calculate(entries,segments,config)
 const historicalBreachCount=entries.filter(entry=>entry.queueId===config.queueId&&entry.kind!=='callback'&&entry.enteredAt>=config.startAt&&entry.enteredAt<config.endAt&&
  (entry.answeredAt!==undefined&&(entry.answeredAt-entry.enteredAt)/1000>config.targetSeconds||
   entry.abandonedAt!==undefined&&(entry.abandonedAt-entry.enteredAt)/1000>config.targetSeconds&&(!config.excludeShort||(entry.abandonedAt-entry.enteredAt)/1000>=config.shortSeconds))).length
 return {metrics,historicalBreachCount,reviewedEntries:entries.length,source:'reviewed queue datasets; native staffing and waiting counts shown separately'}
}

export async function queueSnapshot(env:Bindings,actor:Session,queueId:string){
 const ctx={env,actor},grant=await authorize(ctx,queueId)
 const queue=await env.DB.prepare('SELECT id,name FROM hnd_queues WHERE id=?').bind(queueId).first<Pick<Queue,'id'|'name'>>()
 if(!queue)throw new Fault('queue_not_found',404)
 try{
  const now=Date.now(),[report,liveRows,roster]=await Promise.all([
   scopedMetrics(ctx,queueId),
   env.DB.prepare(`SELECT state,count(*) AS count,min(queued_at) AS oldest FROM hnd_queue_entries WHERE queue_id=? AND state IN ('waiting','reserved','active') GROUP BY state`).bind(queueId).all<{state:string;count:number;oldest:number}>(),
   env.DB.prepare(`SELECT a.*,o.display_name,o.status,m.logged_in,
    (SELECT count(*) FROM hnd_queue_reservations r WHERE r.agent_id=a.operator_id)+
    (SELECT count(*) FROM hnd_dialer_reservations r WHERE r.agent_id=a.operator_id) AS occupied
    FROM hnd_queue_memberships m JOIN hnd_queue_agents a ON a.operator_id=m.operator_id JOIN oa_operators o ON o.id=a.operator_id
    WHERE m.queue_id=? ORDER BY o.display_name,a.operator_id`).bind(queueId).all<Agent&{display_name:string;status:string;logged_in:number;occupied:number}>(),
  ])
  const count=(state:string)=>liveRows.results.find(r=>r.state===state)?.count??0
  const waiting=liveRows.results.filter(r=>r.state!=='active'),oldest=waiting.length?Math.min(...waiting.map(r=>r.oldest)):now
  const waitingBreachCount=Number((await env.DB.prepare(`SELECT count(*) AS count FROM hnd_queue_entries WHERE queue_id=? AND state IN ('waiting','reserved') AND queued_at<?`).bind(queueId,now-report.metrics.config.targetSeconds*1000).first<{count:number}>())?.count??0)
  await authorize(ctx,queueId)
  await commit(env,actor,'product.access','installation','completed',[nativeFence(ctx),scopeFence(ctx,grant)],false)
  return {queue,capturedAt:now,status:'current' as const,stale:false,reason:null,...report,
   live:{waiting:count('waiting'),reserved:count('reserved'),active:count('active'),longestWaitSeconds:Math.max(0,(now-oldest)/1000),breachCount:waitingBreachCount+report.historicalBreachCount,waitingBreachCount,historicalBreachCount:report.historicalBreachCount,breached:waitingBreachCount>0||report.historicalBreachCount>0},
   agents:roster.results.map(a=>({operator_id:a.operator_id,display_name:a.display_name,availability:a.availability,revision:a.revision,loggedIn:a.logged_in===1,
    presenceFresh:a.heartbeat_at>now-presenceFreshMs,wrapping:a.wrap_until>now,activeAssignments:a.occupied,
    dispatchEligible:a.status==='active'&&a.logged_in===1&&a.availability==='available'&&a.heartbeat_at>now-presenceFreshMs&&a.wrap_until<=now&&a.occupied<a.capacity})),
   canIntervene:grant.can_intervene===1,refreshAfterMs,staleAfterMs,activeCallsPreserved:true}
 }catch(error){
  // Authority failures always clear the client. Missing or interrupted source
  // data carries no replacement zeros; the client keeps its last timestamped view.
  if(error instanceof Fault&&!['queue_metric_config_required','supervision_metric_source_conflict'].includes(error.code))throw error
  await authorize(ctx,queueId)
  return {queue,capturedAt:null,status:'unavailable' as const,stale:true,reason:error instanceof Fault?error.code:'supervision_source_unavailable',metrics:null,live:null,agents:[],canIntervene:grant.can_intervene===1,refreshAfterMs,staleAfterMs,activeCallsPreserved:true}
 }
}

export async function queueTimeline(env:Bindings,actor:Session,queueId:string){
 const ctx={env,actor},grant=await authorize(ctx,queueId)
 const events=(await env.DB.prepare(`SELECT i.id,i.actor_ref AS actor,i.occurred_at,i.reason,i.before_state AS from_state,
  i.availability AS to_state,i.agent_revision AS revision,i.agent_id,person.display_name AS agentName,performer.display_name AS actorName
  FROM hnd_supervision_interventions i LEFT JOIN oa_operators person ON person.id=i.agent_id AND person.status='active'
  LEFT JOIN hnd_actor_refs r ON r.pseudonym=i.actor_ref LEFT JOIN oa_operators performer ON performer.id=r.operator_id AND performer.status='active'
  WHERE i.queue_id=? ORDER BY i.occurred_at DESC,i.id DESC LIMIT 200`).bind(queueId).all<TimelineEvent>()).results
 await authorize(ctx,queueId)
 await commit(env,actor,'product.access','installation','completed',[nativeFence(ctx),scopeFence(ctx,grant)],false)
 return {queueId,events,activeCallsPreserved:true}
}

export async function intervene(env:Bindings,actor:Session,queueId:string,agentId:string,value:ObjectValue){
 const ctx={env,actor},grant=await authorize(ctx,queueId,true)
 keys(value,['availability','revision','reason'])
 const availability=choice(value.availability,['available','away'],'availability'),revision=integer(value.revision,'revision',1),reason=text(value.reason,'reason',200)
 const member=await env.DB.prepare('SELECT 1 FROM hnd_queue_memberships WHERE queue_id=? AND operator_id=?').bind(queueId,agentId).first()
 if(!member)throw new Fault('supervision_agent_membership_required',403)
 const shared=await env.DB.prepare(sharedScopeSql).bind(agentId,actor.operator.id,Date.now()).first<Record<string,number>>()
 if(!shared||Object.values(shared)[0]!==1)throw new Fault('supervision_shared_agent_scope_required',403)
 const current=await env.DB.prepare('SELECT * FROM hnd_queue_agents WHERE operator_id=?').bind(agentId).first<Agent>()
 if(!current)throw new Fault('queue_agent_not_found',404)
 if(current.revision!==revision)throw new Fault('agent_revision_conflict',409)
 const now=Date.now(),interventionId=id(),pseudonym=await actorRef(env.DB,actor.operator.id)
 await commit(env,actor,'product.request',interventionId,'completed',[
  nativeFence(ctx),scopeFence(ctx,grant,true),env.DB.prepare('INSERT INTO hnd_guard(ok) '+sharedScopeSql).bind(agentId,actor.operator.id,Date.now()),
  env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_queue_agents a JOIN hnd_queue_memberships m ON m.operator_id=a.operator_id
   JOIN oa_operators o ON o.id=a.operator_id WHERE a.operator_id=? AND a.revision=? AND m.queue_id=? AND o.status='active'`).bind(agentId,revision,queueId),
  // Supervisors cannot manufacture a fresh heartbeat for an absent agent.
  env.DB.prepare('UPDATE hnd_queue_agents SET availability=?,idle_since=CASE WHEN availability<>? THEN ? ELSE idle_since END,revision=revision+1 WHERE operator_id=?').bind(availability,availability,now,agentId),
  env.DB.prepare('INSERT INTO hnd_supervision_interventions VALUES (?,?,?,?,?,?,?,?,?,?)').bind(interventionId,queueId,agentId,pseudonym,now,reason,current.availability,availability,revision+1,grant.id),
  event(ctx,'agent.supervision',queueId,null,agentId,{actor:pseudonym,reason,beforeState:current.availability,availability,interventionId},now),
 ],false)
 return {id:interventionId,agentId,availability,revision:revision+1,actor:pseudonym,occurredAt:now,reason,activeCallsPreserved:true}
}

export async function callControl(env:Bindings,actor:Session,queueId:string,entryId:string,operation:string,value:ObjectValue={}){
 const ctx={env,actor},grant=await authorize(ctx,queueId,true)
 choice(operation,operations,'operation');keys(value,[])
 const entry=await env.DB.prepare(`SELECT e.id FROM hnd_queue_entries e JOIN hnd_queue_memberships m ON m.operator_id=e.agent_id AND m.queue_id=e.queue_id
  WHERE e.id=? AND e.queue_id=? AND e.state='active'`).bind(entryId,queueId).first()
 await commit(env,actor,'product.request','installation','refused',[nativeFence(ctx),scopeFence(ctx,grant,true)],false)
 if(!entry)throw new Fault('supervision_call_team_required',403)
 throw new Fault('supervision_media_qualification_held',409)
}
