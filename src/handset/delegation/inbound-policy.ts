import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, id, integer, keys, owner, text, type ObjectValue } from '../core'
import { overflowUrl, type AgentRoute } from '../queues/media-policy'
import { delegationFence, guard, line, sql, type Delegation, type Line } from './store'

export interface InboundRoute {
 id:string;line_id:string;line_revision:number;delegation_id:string|null;
 endpoint_kind:'client'|'sip'|null;endpoint_destination:string|null;endpoint_revision:number|null;
 voicemail_url:string;max_seconds:number;expires_at:number;revision:number;approved_by:string;owner_version:number;
}
export const lineFence=(env:Bindings,l:Line)=>guard(env,`SELECT count(*) FROM hnd_frontdesk_lines l JOIN oa_operators o ON o.id=l.created_by JOIN oa_operators p ON p.id=l.principal_id WHERE l.id=? AND l.revision=? AND o.status='active' AND o.role='owner' AND o.version=l.owner_version AND p.status='active'`,l.id,l.revision)
export const inboundRouteFence=(env:Bindings,r:InboundRoute)=>guard(env,`SELECT count(*) FROM hnd_frontdesk_routing r JOIN oa_operators o ON o.id=r.approved_by WHERE r.id=? AND r.revision=? AND r.line_revision=? AND r.expires_at>? AND o.role='owner' AND o.status='active' AND o.version=r.owner_version`,r.id,r.revision,r.line_revision,Date.now())
export const endpointFence=(env:Bindings,assistantId:string,sourceId:string,revision:number)=>guard(env,`SELECT count(*) FROM hnd_queue_agent_routes r JOIN oa_operators o ON o.id=r.approved_by JOIN oa_operators p ON p.id=r.operator_id WHERE r.operator_id=? AND r.source_id=? AND r.revision=? AND r.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=r.owner_version AND p.status='active'`,assistantId,sourceId,revision)
export async function approveInbound(env:Bindings,actor:Session,v:ObjectValue){
 owner(actor);keys(v,['lineId','lineRevision','revision','delegationId','voicemailUrl','maxSeconds','expiresAt','confirm'])
 if(v.confirm!=='approve exact inbound coverage voicemail and forwarding')throw new Fault('inbound_route_consent_required',403)
 const l=await line(env,text(v.lineId,'lineId'))
 if(l.revision!==integer(v.lineRevision,'lineRevision',1))throw new Fault('line_version_conflict',409)
 const previous=await sql(env,'SELECT * FROM hnd_frontdesk_routing WHERE line_id=?',l.id).first<InboundRoute>()
 if(previous&&previous.revision!==integer(v.revision,'revision',1))throw new Fault('inbound_route_version_conflict',409)
 const voicemail=overflowUrl(v.voicemailUrl,env.AUTH_ORIGIN),max=integer(v.maxSeconds,'maxSeconds',1,3600),expires=integer(v.expiresAt,'expiresAt',Date.now()+1000,Date.now()+86400000)
 const grantId=v.delegationId?text(v.delegationId,'delegationId'):null,fences=[lineFence(env,l)]
 let endpoint:AgentRoute|null=null
 if(grantId){
  const d=await sql(env,'SELECT * FROM hnd_delegations WHERE id=? AND line_id=?',grantId,l.id).first<Delegation>()
  if(!d)throw new Fault('line_delegation_required',403)
  fences.push(delegationFence(env,d.assistant_id,d,l))
  endpoint=await sql(env,`SELECT r.* FROM hnd_queue_agent_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.operator_id=? AND r.source_id=? AND r.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=r.owner_version`,d.assistant_id,l.source_id).first<AgentRoute>()
  if(!endpoint)throw new Fault('approved_assistant_endpoint_required',409)
  fences.push(endpointFence(env,d.assistant_id,l.source_id,endpoint.revision))
 }
 if(previous)fences.push(guard(env,'SELECT count(*) FROM hnd_frontdesk_routing WHERE id=? AND revision=?',previous.id,previous.revision))
 const target=previous?.id??id(),revision=(previous?.revision??0)+1
 await commit(env,actor,'frontdesk.approve',target,'completed',[
  ...fences,
  guard(env,`SELECT count(*) FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id WHERE s.id=? AND s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=s.owner_version`,l.source_id),
  sql(env,`INSERT INTO hnd_frontdesk_routing VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(line_id) DO UPDATE SET line_revision=excluded.line_revision,delegation_id=excluded.delegation_id,endpoint_kind=excluded.endpoint_kind,endpoint_destination=excluded.endpoint_destination,endpoint_revision=excluded.endpoint_revision,voicemail_url=excluded.voicemail_url,max_seconds=excluded.max_seconds,expires_at=excluded.expires_at,revision=excluded.revision,approved_by=excluded.approved_by,owner_version=excluded.owner_version`,target,l.id,l.revision,grantId,endpoint?.kind??null,endpoint?.destination??null,endpoint?.revision??null,voicemail,max,expires,revision,actor.operator.id,actor.operator.version),
 ],true,{line:{id:l.id,revision:l.revision,ownerVersion:l.owner_version},route:{id:target,revision,ownerVersion:actor.operator.version}})
 return {id:target,revision,lineRevision:l.revision,expiresAt:expires,callbackPath:'/providers/twilio/protection',providerConfigurationChanged:false,delivery:'instructions only; receiver audio unqualified'}
}
