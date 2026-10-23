import type { Bindings } from '../../auth.server'
import { actorRef, append } from '../audit/store'
import { sourcePolicy, type AppliedPolicy } from '../audit/policy'
import { Fault } from '../core'
import { activeSourceById, sourceFence } from '../providers/sources'
import { xml } from '../protection/twiml'
import { destination } from '../queues/media-policy'
import { readCall } from '../queues/provider-api'
import { endpointFence, inboundRouteFence, lineFence, type InboundRoute } from './inbound-policy'
import { delegationFence, guard, line, linePolicy, sql, type Delegation } from './store'

interface Receipt {id:string;source_id:string;call_sid:string;line_id:string;line_revision:number;route_revision:number|null;branch:string;created_at:number;snapshot:string;answered_call_sid:string|null}
interface Snapshot {account:string;parentFrom:string;parentTo:string;sourceRevision:number;sourceOwnerVersion:number;routeId:string;routeRevision:number;lineRevision:number;destination:string;kind:'sip'|'client'|'number';delegationId?:string;endpointRevision?:number}
const insist=(condition:unknown,code:string)=>{if(!condition)throw new Fault(code,403)}

/** An answer permits only the already emitted child leg, after fresh authority
 * and provider readback. A completed audit means authorization, never audio. */
export async function inboundAnswer(env:Bindings,receiptId:string,p:URLSearchParams):Promise<Response>{
 let actor='anonymous',subject='installation',principal:string|null=null,applied:AppliedPolicy={}
 try{
  const receipt=await sql(env,'SELECT * FROM hnd_frontdesk_inbound WHERE id=?',receiptId).first<Receipt>()
  if(!receipt)throw new Fault('frontdesk_answer_unknown',404)
  actor=receipt.source_id;subject=receipt.id
  insist(['dnd_assistant','external_forward'].includes(receipt.branch),'frontdesk_answer_branch_refused')
  const snapshot=JSON.parse(receipt.snapshot) as Snapshot,sid=p.get('CallSid')
  insist(snapshot&&typeof snapshot==='object'&&typeof snapshot.parentFrom==='string'&&snapshot.parentFrom.length>0&&sid&&sid!==receipt.call_sid&&Number.isSafeInteger(receipt.created_at),'frontdesk_answer_invalid')
  insist(!receipt.answered_call_sid||receipt.answered_call_sid===sid,'frontdesk_answer_child_conflict')
  const source=await activeSourceById(env,receipt.source_id)
  if(!source)throw new Fault('frontdesk_answer_source_inactive',403)
  insist(source.revision===snapshot.sourceRevision&&source.owner_version===snapshot.sourceOwnerVersion&&source.account_id===snapshot.account&&source.e164===snapshot.parentTo,'frontdesk_answer_source_changed')
  applied=sourcePolicy(source)
  const l=await line(env,receipt.line_id)
  principal=await actorRef(env.DB,l.principal_id)
  insist(l.source_id===source.id&&l.number_id===source.number_id&&l.revision===receipt.line_revision&&l.revision===snapshot.lineRevision,'frontdesk_answer_line_changed')
  applied.line={id:l.id,revision:l.revision,ownerVersion:l.owner_version}
  const route=await sql(env,'SELECT * FROM hnd_frontdesk_routing WHERE line_id=?',l.id).first<InboundRoute>()
  if(!route)throw new Fault('frontdesk_answer_route_inactive',403)
  insist(route.id===snapshot.routeId&&route.revision===receipt.route_revision&&route.revision===snapshot.routeRevision&&route.line_revision===l.revision,'frontdesk_answer_route_changed')
  applied.route={id:route.id,revision:route.revision,ownerVersion:route.owner_version}
  let delegation:Delegation|null=null
  if(receipt.branch==='external_forward'){
   insist(snapshot.kind==='number'&&typeof snapshot.destination==='string'&&/^\+[1-9]\d{7,14}$/.test(snapshot.destination)&&snapshot.destination!==snapshot.parentTo,'frontdesk_answer_destination_changed')
  }else{
   insist(snapshot.kind==='sip'||snapshot.kind==='client','frontdesk_answer_endpoint_changed')
   destination(snapshot.kind as 'sip'|'client',snapshot.destination)
   insist(route.delegation_id===snapshot.delegationId&&route.endpoint_kind===snapshot.kind&&route.endpoint_destination===snapshot.destination&&route.endpoint_revision===snapshot.endpointRevision,'frontdesk_answer_endpoint_changed')
   delegation=await sql(env,'SELECT * FROM hnd_delegations WHERE id=? AND line_id=?',snapshot.delegationId??null,l.id).first<Delegation>()
   if(!delegation)throw new Fault('frontdesk_answer_delegation_inactive',403)
   applied.delegation={id:delegation.id,revision:1,ownerVersion:delegation.owner_version}
  }
  const fences=()=>{
   const policy=linePolicy(l)
   insist(route.expires_at>Date.now(),'frontdesk_answer_route_expired')
   insist(receipt.branch==='external_forward'?policy.forwardTo===snapshot.destination:!policy.forwardTo&&policy.withinHours&&policy.dnd,'frontdesk_answer_policy_changed')
   return [sourceFence(env,source),lineFence(env,l),inboundRouteFence(env,route),
    guard(env,'SELECT count(*) FROM hnd_frontdesk_inbound WHERE id=? AND source_id=? AND call_sid=? AND line_id=? AND line_revision=? AND route_revision=? AND branch=? AND snapshot=? AND created_at=? AND (answered_call_sid IS NULL OR answered_call_sid=?)',receipt.id,source.id,receipt.call_sid,l.id,l.revision,route.revision,receipt.branch,receipt.snapshot,receipt.created_at,sid!),
    ...(delegation?[
     delegationFence(env,delegation.assistant_id,delegation,l),endpointFence(env,delegation.assistant_id,source.id,snapshot.endpointRevision!),
     guard(env,'SELECT count(*) FROM hnd_queue_agent_routes WHERE operator_id=? AND source_id=? AND revision=? AND kind=? AND destination=?',delegation.assistant_id,source.id,snapshot.endpointRevision!,snapshot.kind,snapshot.destination),
    ]:[]),
   ]
  }
  await env.DB.batch([...fences(),sql(env,'DELETE FROM hnd_guard')])
  insist(p.get('AccountSid')===snapshot.account&&(!p.has('ParentCallSid')||p.get('ParentCallSid')===receipt.call_sid),'frontdesk_answer_callback_mismatch')
  const [child,parent]=await Promise.all([readCall({env},snapshot.account,sid!),readCall({env},snapshot.account,receipt.call_sid)])
  const matches=snapshot.kind==='client'?child.to==='client:'+snapshot.destination:child.to===snapshot.destination||snapshot.kind==='sip'&&child.to===snapshot.destination.replace(/^sips?:/,'')
  insist(child.direction==='outbound-dial'&&child.parent_call_sid===receipt.call_sid&&child.from===snapshot.parentTo&&matches&&child.status==='in-progress','frontdesk_answer_child_mismatch')
  insist(p.get('From')===child.from&&p.get('To')===child.to,'frontdesk_answer_callback_mismatch')
  const created=Date.parse(child.date_created)
  insist(Number.isFinite(created)&&created>=receipt.created_at-1000,'frontdesk_answer_child_time_mismatch')
  insist(parent.direction==='inbound'&&parent.from===snapshot.parentFrom&&parent.to===snapshot.parentTo&&['ringing','in-progress'].includes(parent.status)&&Number.isFinite(Date.parse(parent.date_created)),'frontdesk_answer_parent_mismatch')
  await append(env,actor,'frontdesk.answer',subject,'completed',[
   ...fences(),
   sql(env,'UPDATE hnd_frontdesk_inbound SET answered_call_sid=COALESCE(answered_call_sid,?),bridge_authorized_at=COALESCE(bridge_authorized_at,?) WHERE id=? AND (answered_call_sid IS NULL OR answered_call_sid=?)',sid!,Date.now(),receipt.id,sid!),
  ],principal,applied)
  return xml('')
 }catch(error){
  // Refusals must survive the authority failure that caused them.
  try{await append(env,actor,'frontdesk.answer',subject,'refused',[],principal,applied)}catch{return xml('<Hangup/>','frontdesk_answer_audit_unavailable')}
  return xml('<Hangup/>',error instanceof Fault?error.code:'frontdesk_answer_unavailable')
 }
}
