import { choice, Fault, id, integer, keys, text, type ObjectValue } from '../core'
import { agent, event, guard, queue, statement, write, type OwnerContext as Context } from './storage'
import { language, list, presenceFreshMs, queueInput, type Agent, type Queue } from './model'

export async function configureQueue(ctx:Context,value:ObjectValue,queueId?:string){
 const v=queueInput(value),now=Date.now(),target=queueId??id(),statements:D1PreparedStatement[]=[statement(ctx,'INSERT INTO hnd_queue_runtime VALUES (1,?) ON CONFLICT DO NOTHING',id())]
 if(v.overflowQueueId){
  const seen=new Set([target]);let next:string|null=v.overflowQueueId
  while(next){if(seen.has(next))throw new Fault('overflow_cycle');seen.add(next);const q=await queue(ctx,next);next=q.overflow_queue_id}
 }
 if(queueId){
  const current=await queue(ctx,queueId),revision=integer(value.revision,'revision',1)
  if(revision!==current.revision)throw new Fault('queue_revision_conflict',409,{current})
  // In-flight callers retain the deadline promised at entry; changed wrap-up
  // applies to calls completed after this explicit policy revision.
  statements.push(guard(ctx,'SELECT count(*) FROM hnd_queues WHERE id=? AND revision=?',queueId,revision),
   statement(ctx,`UPDATE hnd_queues SET name=?,mode=?,skills=?,max_wait_seconds=?,wrap_seconds=?,max_waiting=?,overflow_kind=?,overflow_queue_id=?,revision=revision+1,updated_at=? WHERE id=?`,v.name,v.mode,v.skills,v.maxWait,v.wrap,v.maxWaiting,v.overflowKind,v.overflowQueueId,now,queueId))
 }else statements.push(statement(ctx,`INSERT INTO hnd_queues(id,name,mode,skills,max_wait_seconds,wrap_seconds,max_waiting,overflow_kind,overflow_queue_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,target,v.name,v.mode,v.skills,v.maxWait,v.wrap,v.maxWaiting,v.overflowKind,v.overflowQueueId,now,now))
 // Recheck the reviewed overflow path inside the write; concurrent graph edits
 // cannot introduce a route cycle after the review read above.
 if(v.overflowQueueId)statements.push(guard(ctx,`WITH RECURSIVE path(id) AS (SELECT ? UNION SELECT q.overflow_queue_id FROM hnd_queues q JOIN path p ON q.id=p.id WHERE q.overflow_queue_id IS NOT NULL) SELECT CASE WHEN EXISTS(SELECT 1 FROM path WHERE id=?) THEN 0 ELSE 1 END`,v.overflowQueueId,target))
 statements.push(event(ctx,'queue.configured',target,null,null,{revision:queueId?Number(value.revision)+1:1}))
 await write(ctx,target,statements);return queue(ctx,target)
}
export async function configureAgent(ctx:Context,value:ObjectValue){
 keys(value,['operatorId','skills','languages','capacity','revision','confirm'])
 if(value.confirm!=='approve native agent capabilities')throw new Fault('agent_consent_required',403)
 const target=text(value.operatorId,'operatorId'),skills=JSON.stringify(list(value.skills??[],'skills'))
 const languages=list(value.languages??[],'languages').map(language)
 if(!languages.length)throw new Fault('agent_language_required')
 const capacity=integer(value.capacity??1,'capacity',1,10),now=Date.now()
 const current=await statement(ctx,'SELECT * FROM hnd_queue_agents WHERE operator_id=?',target).first<Agent>()
 const statements=[guard(ctx,"SELECT count(*) FROM oa_operators WHERE id=? AND status='active'",target)]
 if(current){
  const revision=integer(value.revision,'revision',1)
  if(current.revision!==revision)throw new Fault('agent_revision_conflict',409,{current})
  statements.push(guard(ctx,'SELECT count(*) FROM hnd_queue_agents WHERE operator_id=? AND revision=?',target,revision),
   guard(ctx,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_queue_reservations WHERE agent_id=? AND slot>?) THEN 0 ELSE 1 END',target,capacity),
   statement(ctx,'UPDATE hnd_queue_agents SET skills=?,languages=?,capacity=?,revision=revision+1 WHERE operator_id=?',skills,JSON.stringify(languages),capacity,target))
 }else statements.push(statement(ctx,`INSERT INTO hnd_queue_agents(operator_id,skills,languages,capacity,availability,heartbeat_at,idle_since) VALUES (?,?,?,?,'offline',0,?)`,target,skills,JSON.stringify(languages),capacity,now))
 statements.push(event(ctx,'agent.configured',null,null,target,{capacity}))
 await write(ctx,'installation',statements);return agent(ctx,target)
}
export async function presence(ctx:Context,value:ObjectValue){
 keys(value,['operatorId','availability','revision'])
 const target=text(value.operatorId??ctx.actor.operator.id,'operatorId'),current=await agent(ctx,target)
 const availability=choice(value.availability,['available','busy','away','offline'],'availability'),revision=integer(value.revision,'revision',1),now=Date.now()
 if(current.revision!==revision)throw new Fault('agent_revision_conflict',409,{current})
 await write(ctx,'installation',[
  guard(ctx,"SELECT count(*) FROM oa_operators WHERE id=? AND status='active'",target),
  guard(ctx,'SELECT count(*) FROM hnd_queue_agents WHERE operator_id=? AND revision=?',target,revision),
  statement(ctx,'UPDATE hnd_queue_agents SET availability=?,heartbeat_at=?,idle_since=CASE WHEN availability<>? THEN ? ELSE idle_since END,revision=revision+1 WHERE operator_id=?',availability,now,availability,now,target),
  event(ctx,'agent.presence',null,null,target,{availability,freshUntil:now+presenceFreshMs}),
 ])
 // Presence never removes a reservation or an active assignment.
 return agent(ctx,target)
}
export async function membership(ctx:Context,queueId:string,value:ObjectValue){
 keys(value,['operatorId','loggedIn','priority','revision','confirm'])
 if(value.confirm!=='approve queue membership')throw new Fault('membership_consent_required',403)
 const q=await queue(ctx,queueId),target=text(value.operatorId,'operatorId'),loggedIn=integer(value.loggedIn,'loggedIn',0,1),priority=integer(value.priority??0,'priority',0,100)
 await agent(ctx,target)
 const current=await statement(ctx,'SELECT revision FROM hnd_queue_memberships WHERE queue_id=? AND operator_id=?',q.id,target).first<{revision:number}>()
 const statements=[guard(ctx,"SELECT count(*) FROM oa_operators WHERE id=? AND status='active'",target)]
 if(current){
  const revision=integer(value.revision,'revision',1)
  if(revision!==current.revision)throw new Fault('membership_revision_conflict',409)
  statements.push(guard(ctx,'SELECT count(*) FROM hnd_queue_memberships WHERE queue_id=? AND operator_id=? AND revision=?',q.id,target,revision))
 }else statements.push(guard(ctx,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_queue_memberships WHERE queue_id=? AND operator_id=?) THEN 0 ELSE 1 END',q.id,target))
 statements.push(statement(ctx,`INSERT INTO hnd_queue_memberships(queue_id,operator_id,logged_in,priority,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(queue_id,operator_id) DO UPDATE SET logged_in=excluded.logged_in,priority=excluded.priority,revision=revision+1,updated_at=excluded.updated_at`,q.id,target,loggedIn,priority,Date.now()),
  event(ctx,'membership.changed',q.id,null,target,{loggedIn:Boolean(loggedIn),priority}))
 await write(ctx,q.id,statements)
 return (await statement(ctx,'SELECT * FROM hnd_queue_memberships WHERE queue_id=? AND operator_id=?',q.id,target).first())!
}
