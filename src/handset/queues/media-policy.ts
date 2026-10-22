import { choice, Fault, integer, keys, text, type ObjectValue } from '../core'
import { agent, event, guard, queue, statement, write, type Context, type OwnerContext } from './storage'

export interface AgentRoute {operator_id:string;source_id:string;kind:'client'|'sip';destination:string;revision:number;approved_by:string;owner_version:number;approved_at:number;revoked_at:number|null;suspended?:number}
export interface OverflowRoute {queue_id:string;kind:'voicemail'|'receptionist';url:string;revision:number;approved_by:string;owner_version:number;approved_at:number;revoked_at:number|null;suspended?:number}
function publicHost(host:string){
 return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)&&host.includes('.')&&!/^\d+(?:\.\d+){3}$/.test(host)&&!/(?:^|\.)(?:localhost|local|internal|invalid)$/.test(host)
}
export function destination(kind:'client'|'sip',value:unknown){
 const result=text(value,'destination',256)
 if(kind==='client'){
  if(!/^[A-Za-z0-9_]{1,256}$/.test(result))throw new Fault('invalid_client_identity')
 }else{
  // No passwords, headers, URI parameters, escapes or routing tricks. Scoped
  // TLS/SIP registration is the endpoint's job; this stores only its address.
  const match=result.match(/^sips?:([A-Za-z0-9_.+-]+)@([a-zA-Z0-9.-]+)(?::(\d{1,5}))?$/)
  if(!match||!publicHost(match[2])||match[3]&&(!Number(match[3])||Number(match[3])>65535))throw new Fault('invalid_sip_destination')
 }
 return result
}
export function overflowUrl(value:unknown,origin:string){
 const raw=text(value,'url',2000);let url:URL
 try{url=new URL(raw)}catch{throw new Fault('invalid_overflow_url')}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port&&url.port!=='443'||!publicHost(url.hostname)||url.origin===origin)throw new Fault('invalid_overflow_url')
 return url.href
}
export async function writeAgentRoute(ctx:OwnerContext,operatorId:string,value:ObjectValue){
 keys(value,['sourceId','kind','destination','revision','confirm'])
 if(value.confirm!=='approve exact queue agent route')throw new Fault('agent_route_consent_required',403)
 await agent(ctx,operatorId)
 const sourceId=text(value.sourceId,'sourceId')
 const kind=choice(value.kind,['client','sip'],'kind'),target=destination(kind,value.destination),current=await statement(ctx,'SELECT * FROM hnd_queue_agent_routes WHERE operator_id=?',operatorId).first<AgentRoute>()
 const revision=current?integer(value.revision,'revision',1):0
 if(current&&current.revision!==revision)throw new Fault('agent_route_revision_conflict',409)
 const fences=[guard(ctx,"SELECT count(*) FROM oa_operators WHERE id=? AND status='active'",operatorId),guard(ctx,`SELECT count(*) FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id WHERE s.id=? AND s.revoked_at IS NULL AND o.status='active' AND o.role='owner'`,sourceId)]
 if(current)fences.push(guard(ctx,'SELECT count(*) FROM hnd_queue_agent_routes WHERE operator_id=? AND revision=?',operatorId,revision))
 await write(ctx,'installation',[...fences,statement(ctx,`INSERT INTO hnd_queue_agent_routes VALUES (?,?,?,?,?,?,?,?,NULL) ON CONFLICT(operator_id) DO UPDATE SET source_id=excluded.source_id,kind=excluded.kind,destination=excluded.destination,revision=excluded.revision,approved_by=excluded.approved_by,owner_version=excluded.owner_version,approved_at=excluded.approved_at,revoked_at=NULL`,operatorId,sourceId,kind,target,revision+1,ctx.actor.operator.id,ctx.actor.operator.version,Date.now()),event(ctx,'agent.route_approved',null,null,operatorId,{routeRevision:revision+1,kind})])
 return statement(ctx,'SELECT * FROM hnd_queue_agent_routes WHERE operator_id=?',operatorId).first<AgentRoute>()
}
export async function writeOverflowRoute(ctx:OwnerContext,queueId:string,value:ObjectValue){
 keys(value,['url','revision','confirm'])
 if(value.confirm!=='approve exact queue overflow route')throw new Fault('overflow_route_consent_required',403)
 const q=await queue(ctx,queueId)
 if(q.overflow_kind==='queue')throw new Fault('overflow_uses_native_queue')
 const url=overflowUrl(value.url,ctx.env.AUTH_ORIGIN),current=await statement(ctx,'SELECT * FROM hnd_queue_overflow_routes WHERE queue_id=?',q.id).first<OverflowRoute>()
 const revision=current?integer(value.revision,'revision',1):0
 if(current&&current.revision!==revision)throw new Fault('overflow_route_revision_conflict',409)
 const fences=[guard(ctx,'SELECT count(*) FROM hnd_queues WHERE id=? AND revision=?',q.id,q.revision)]
 if(current)fences.push(guard(ctx,'SELECT count(*) FROM hnd_queue_overflow_routes WHERE queue_id=? AND revision=?',q.id,revision))
 await write(ctx,q.id,[...fences,statement(ctx,`INSERT INTO hnd_queue_overflow_routes VALUES (?,?,?,?,?,?,?,NULL) ON CONFLICT(queue_id) DO UPDATE SET kind=excluded.kind,url=excluded.url,revision=excluded.revision,approved_by=excluded.approved_by,owner_version=excluded.owner_version,approved_at=excluded.approved_at,revoked_at=NULL`,q.id,q.overflow_kind,url,revision+1,ctx.actor.operator.id,ctx.actor.operator.version,Date.now()),event(ctx,'overflow.route_approved',q.id,null,null,{routeRevision:revision+1,kind:q.overflow_kind})])
 return statement(ctx,'SELECT * FROM hnd_queue_overflow_routes WHERE queue_id=?',q.id).first<OverflowRoute>()
}
export async function revokeMediaRoute(ctx:OwnerContext,kind:'agent'|'overflow',target:string){
 const table=kind==='agent'?'hnd_queue_agent_routes':'hnd_queue_overflow_routes',column=kind==='agent'?'operator_id':'queue_id'
 await write(ctx,kind==='agent'?'installation':target,[statement(ctx,`UPDATE ${table} SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE ${column}=?`,Date.now(),target),event(ctx,kind==='agent'?'agent.route_revoked':'overflow.route_revoked',kind==='overflow'?target:null,null,kind==='agent'?target:null)])
 return {revoked:true}
}
export async function activeOverflow(ctx:Context,queueId:string,kind:string){
 return statement(ctx,`SELECT r.* FROM hnd_queue_overflow_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.queue_id=? AND r.kind=? AND r.revoked_at IS NULL AND o.status='active' AND o.role='owner'`,queueId,kind).first<OverflowRoute>()
}
export async function routeReady(ctx:Context,queueId:string,seen=new Set<string>()){
 if(seen.has(queueId))throw new Fault('overflow_cycle',409);seen.add(queueId)
 const q=await queue(ctx,queueId)
 if(q.overflow_kind==='queue'&&q.overflow_queue_id)return routeReady(ctx,q.overflow_queue_id,seen)
 if(!await activeOverflow(ctx,q.id,q.overflow_kind))throw new Fault('queue_overflow_route_unqualified',409,{queueId:q.id})
}
