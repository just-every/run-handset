import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { actorRef, append, commit } from '../audit/store'
import { Fault, escape as e, integer, keys, owner, text, type ObjectValue } from '../core'
import { readCall } from '../queues/provider-api'
import { providerGet, waitingAgent } from '../dialer/network'
import { listEligibility } from '../dialer/eligibility'
import { createSession, launch } from '../dialer/launch'
import { reconcileAttempt } from '../dialer/readback'
import { list, recipients, type Context } from '../dialer/storage'
import type { Attempt, Ready } from '../dialer/model'
import type { AgentRoute } from '../queues/media-policy'
import { delegated, delegationFence, guard, linePolicy, nativeFence, sql } from './store'

interface Operation {id:string;delegation_id:string;actor:string;principal:string;kind:'pickup'|'park'|'transfer'|'callback';call_id:string|null;target:string|null;line_revision:number;state:'held'|'uncertain'|'provider_observed'|'refused';created_at:number}
interface Snapshot {kind:string;lineId:string;lineRevision:number;sourceId:string;account:string;parentSid?:string;parentFrom?:string;parentTo?:string;conferenceSid?:string;conferenceName?:string;agentCallSid?:string;endpointId?:string;routeRevision?:number;listId?:string;listHash?:string;maxSeconds:number}
interface Approval {operation_id:string;snapshot:string;approved_by:string;owner_version:number;expires_at:number;session_id:string|null;observation:string}
async function operation(env:Bindings,target:string){const r=await sql(env,'SELECT * FROM hnd_frontdesk_operations WHERE id=?',target).first<Operation>();if(!r)throw new Fault('call_request_not_found',404);return r}
async function currentSource(env:Bindings,sourceId:string){const r=await sql(env,`SELECT s.account_id FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id WHERE s.id=? AND s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=s.owner_version`,sourceId).first<{account_id:string}>();if(!r)throw new Fault('source_authority_changed',409);return r.account_id}
async function endpoint(ctx:Context,sourceId:string,operatorId:string){
 const route=await sql(ctx.env,`SELECT r.* FROM hnd_queue_agent_routes r JOIN oa_operators o ON o.id=r.approved_by JOIN oa_operators p ON p.id=r.operator_id WHERE r.operator_id=? AND r.source_id=? AND r.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=r.owner_version AND p.status='active'`,operatorId,sourceId).first<AgentRoute>()
 const ready=await sql(ctx.env,`SELECT r.* FROM hnd_dialer_ready r JOIN oa_operators o ON o.id=r.approved_by WHERE r.agent_id=? AND r.source_id=? AND r.expires_at>? AND o.status='active' AND o.version=r.owner_version AND (o.role='owner' OR r.approved_by=r.agent_id)`,operatorId,sourceId,Date.now()).first<Ready>()
 if(!route||!ready)throw new Fault('preconnected_exact_endpoint_required',409)
 return {route,ready}
}
function approvalFence(env:Bindings,a:Approval){return guard(env,`SELECT count(*) FROM hnd_frontdesk_controls c JOIN oa_operators o ON o.id=c.approved_by WHERE c.operation_id=? AND c.expires_at>? AND o.role='owner' AND o.status='active' AND o.version=c.owner_version`,a.operation_id,Date.now())}
function endpointFence(env:Bindings,s:Snapshot){return guard(env,`SELECT count(*) FROM hnd_dialer_ready r JOIN hnd_queue_agent_routes route ON route.operator_id=r.agent_id AND route.source_id=r.source_id JOIN oa_operators o ON o.id=route.approved_by JOIN oa_operators a ON a.id=r.approved_by JOIN oa_operators p ON p.id=r.agent_id WHERE r.agent_id=? AND r.source_id=? AND r.conference_sid=? AND r.conference_name=? AND r.agent_call_sid=? AND r.expires_at>? AND route.revision=? AND route.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=route.owner_version AND a.status='active' AND a.version=r.owner_version AND (a.role='owner' OR r.approved_by=r.agent_id) AND p.status='active'`,s.endpointId!,s.sourceId,s.conferenceSid!,s.conferenceName!,s.agentCallSid!,Date.now(),s.routeRevision!)}
export async function approveControl(env:Bindings,actor:Session,v:ObjectValue){
 owner(actor);if(!env.HANDSET_TWILIO_AUTH_TOKEN)throw new Fault('provider_credentials_unavailable',503);keys(v,['operationId','listId','maxSeconds','expiresAt','confirm'])
 if(v.confirm!=='approve this exact existing call move or single callback')throw new Fault('exact_call_control_approval_required',403)
 const op=await operation(env,text(v.operationId,'operationId'))
 if(op.state!=='held')throw new Fault('call_request_already_started',409)
 const delegation=await sql(env,'SELECT assistant_id FROM hnd_delegations WHERE id=?',op.delegation_id).first<{assistant_id:string}>()
 if(!delegation)throw new Fault('delegation_required',403)
 // Approval does not borrow the assistant's session; it snapshots current native
 // line state and the exact request, which execution later fences as assistant.
 const l=await sql(env,'SELECT * FROM hnd_frontdesk_lines WHERE id=(SELECT line_id FROM hnd_delegations WHERE id=?)',op.delegation_id).first<import('./store').Line>()
 if(!l||l.revision!==op.line_revision)throw new Fault('line_policy_changed',409)
 const account=await currentSource(env,l.source_id),maxSeconds=integer(v.maxSeconds,'maxSeconds',1,3600),expires=integer(v.expiresAt,'expiresAt',Date.now()+1000,Date.now()+300000),ctx={env,actor},snapshot:Snapshot={kind:op.kind,lineId:l.id,lineRevision:l.revision,sourceId:l.source_id,account,maxSeconds}
 const fences:D1PreparedStatement[]=[]
 if(op.kind==='callback'){
  const selected=await list(ctx,text(v.listId,'listId')),eligible=await listEligibility(ctx,selected,'preview'),rows=await recipients(ctx,selected.id)
  if(rows.length!==1||rows[0].recipient!==op.target||selected.source_id!==l.source_id||eligible.definition.repId!==delegation.assistant_id)throw new Fault('exact_single_callback_list_required',409)
  snapshot.listId=selected.id;snapshot.listHash=selected.snapshot_hash;fences.push(...eligible.fences)
 }else{
  if(v.listId)throw new Fault('unexpected_callback_list')
  const r=await sql(env,'SELECT so.external_id,r.data FROM hnd_source_objects so JOIN hnd_records r ON r.id=so.record_id WHERE so.source_id=? AND so.record_id=? AND r.kind=\'call_session\'',l.source_id,op.call_id).first<{external_id:string;data:string}>()
  if(!r)throw new Fault('source_linked_call_required',409)
  const parent=await readCall(ctx,account,r.external_id),data=JSON.parse(r.data)
  if(parent.direction!=='inbound'||!['ringing','in-progress'].includes(parent.status)||parent.from!==data.from||parent.to!==data.to)throw new Fault('current_inbound_call_required',409)
  snapshot.parentSid=parent.sid;snapshot.parentFrom=parent.from;snapshot.parentTo=parent.to
  if(op.kind!=='park'){
   const target=op.kind==='transfer'?op.target!:delegation.assistant_id,{route,ready}=await endpoint(ctx,l.source_id,target)
   await waitingAgent(ctx,account,ready,route.destination)
   snapshot.endpointId=target;snapshot.routeRevision=route.revision;snapshot.conferenceSid=ready.conference_sid;snapshot.conferenceName=ready.conference_name;snapshot.agentCallSid=ready.agent_call_sid
   fences.push(endpointFence(env,snapshot))
  }else snapshot.conferenceName='handset-park-'+op.id
 }
 await commit(env,actor,'frontdesk.approve',op.id,'completed',[...fences,guard(env,"SELECT count(*) FROM hnd_frontdesk_operations WHERE id=? AND state='held'",op.id),guard(env,'SELECT count(*) FROM hnd_frontdesk_lines WHERE id=? AND revision=?',l.id,l.revision),sql(env,'INSERT INTO hnd_frontdesk_controls(operation_id,snapshot,approved_by,owner_version,expires_at) VALUES (?,?,?,?,?)',op.id,JSON.stringify(snapshot),actor.operator.id,actor.operator.version,expires)])
 return {operationId:op.id,snapshot,expiresAt:expires,effectOccurred:false}
}
export async function executeControl(env:Bindings,actor:Session,v:ObjectValue){
 if(!env.HANDSET_TWILIO_AUTH_TOKEN)throw new Fault('provider_credentials_unavailable',503)
 keys(v,['operationId','confirm']);if(v.confirm!=='execute exact approved call request')throw new Fault('call_control_confirmation_required',403)
 const op=await operation(env,text(v.operationId,'operationId')),{d,l}=await delegated(env,actor,op.delegation_id)
 if(op.actor!==await actorRef(env.DB,actor.operator.id))throw new Fault('assistant_actor_required',403)
 const policy=linePolicy(l);if(policy.dnd||!policy.withinHours||policy.forwardTo)throw new Fault('executive_line_policy_refused',403)
 if(op.state!=='held')return {operation:op,replay:true,effectRepeated:false,customerOutcome:'unconfirmed'}
 const a=await sql(env,'SELECT * FROM hnd_frontdesk_controls WHERE operation_id=?',op.id).first<Approval>()
 if(!a)throw new Fault('exact_call_control_approval_required',403)
 const s=JSON.parse(a.snapshot) as Snapshot
 if(s.lineId!==l.id||s.lineRevision!==l.revision||op.line_revision!==l.revision||s.sourceId!==l.source_id||s.account!==await currentSource(env,l.source_id))throw new Fault('reviewed_line_changed',409)
 const fences=()=>{const current=linePolicy(l);if(current.dnd||!current.withinHours||current.forwardTo)throw new Fault('executive_line_policy_refused',403);return [nativeFence(env,actor),delegationFence(env,actor,d,l),approvalFence(env,a)]}
 const ctx:Context={env,actor,requiredAgentId:actor.operator.id,maxCallSeconds:s.maxSeconds,fences}
 if(op.kind!=='callback'){
  const parent=await readCall(ctx,s.account,s.parentSid!)
  if(parent.direction!=='inbound'||parent.from!==s.parentFrom||parent.to!==s.parentTo||!['ringing','in-progress'].includes(parent.status))throw new Fault('reviewed_call_changed',409)
  if(op.kind!=='park'){
   const {route,ready}=await endpoint(ctx,l.source_id,s.endpointId!)
   if(route.revision!==s.routeRevision||ready.conference_sid!==s.conferenceSid||ready.agent_call_sid!==s.agentCallSid||ready.conference_name!==s.conferenceName)throw new Fault('reviewed_endpoint_changed',409)
   await waitingAgent(ctx,s.account,ready,route.destination)
  }
 }
 await append(env,op.actor,'frontdesk.'+op.kind,op.id,'uncertain',[...fences(),...(op.kind!=='park'&&op.kind!=='callback'?[endpointFence(env,s)]:[]),guard(env,"SELECT count(*) FROM hnd_frontdesk_operations WHERE id=? AND state='held'",op.id),sql(env,"UPDATE hnd_frontdesk_operations SET state='uncertain' WHERE id=?",op.id)],op.principal)
 if(op.kind==='callback'){
  const selected=await list(ctx,s.listId!)
  if(selected.snapshot_hash!==s.listHash)throw new Fault('callback_snapshot_changed',409)
  const session=await createSession(ctx,selected.id,{mode:'preview',confirm:'start exact approved list in this mode'})
  await env.DB.batch([...fences(),sql(env,'UPDATE hnd_frontdesk_controls SET session_id=? WHERE operation_id=?',session.id,op.id),sql(env,'DELETE FROM hnd_guard')])
  const launched=await launch(ctx,session.id,{eventKey:'frontdesk:'+op.id,previewRecipient:op.target,confirm:'launch exact approved recipients now'})
  return {operation:await operation(env,op.id),dialer:launched,replay:false,customerOutcome:'unconfirmed'}
 }
 // Move an existing inbound leg to an already connected endpoint, or a private
 // parking conference. No new outbound leg or recording is created here.
 const twiml=`<Response><Dial timeLimit="${s.maxSeconds}"><Conference beep="false" record="do-not-record" startConferenceOnEnter="true" endConferenceOnExit="false" waitUrl="">${e(s.conferenceName)}</Conference></Dial></Response>`
 await env.DB.batch([...fences(),...(op.kind!=='park'?[endpointFence(env,s)]:[]),sql(env,'DELETE FROM hnd_guard')])
 try{await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.account)}/Calls/${encodeURIComponent(s.parentSid!)}.json`,{method:'POST',headers:{authorization:'Basic '+btoa(s.account+':'+env.HANDSET_TWILIO_AUTH_TOKEN),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({Twiml:twiml}),redirect:'manual',signal:AbortSignal.timeout(5000)})}catch{/* uncertain: do not replay or invent an outcome */}
 return {operation:await operation(env,op.id),replay:false,customerOutcome:'unconfirmed',next:'Reconcile provider membership; request acceptance is not pickup, parking or transfer proof.'}
}
export async function reconcileControl(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['operationId']);const op=await operation(env,text(v.operationId,'operationId'))
 const {d,l}=await delegated(env,actor,op.delegation_id)
 if(op.actor!==await actorRef(env.DB,actor.operator.id))throw new Fault('assistant_actor_required',403)
 const a=await sql(env,'SELECT * FROM hnd_frontdesk_controls WHERE operation_id=?',op.id).first<Approval>()
 if(!a||!['uncertain','provider_observed'].includes(op.state))throw new Fault('no_started_call_request',409)
 const s=JSON.parse(a.snapshot) as Snapshot,fences=()=>[nativeFence(env,actor),delegationFence(env,actor,d,l)],ctx={env,actor,fences}
 let observation='unconfirmed'
 if(op.kind==='callback'){
  if(!a.session_id)return {operation:op,observation:'uncertain; no replay or automatic redial',customerOutcome:'unconfirmed'}
  const rows=(await sql(env,'SELECT * FROM hnd_dialer_attempts WHERE session_id=?',a.session_id).all<Attempt>()).results
  if(rows.length!==1)return {operation:op,observation:'uncertain; inspect held dialer admission',customerOutcome:'unconfirmed'}
  const {attempt:result}=await reconcileAttempt(ctx,rows[0])
  if(result.from_number!==JSON.parse((await sql(env,'SELECT data FROM hnd_records WHERE id=?',l.number_id).first<{data:string}>())!.data).e164||result.recipient!==op.target||result.agent_id!==d.assistant_id)throw new Fault('callback_identity_mismatch',502)
  if(result.bridge_observed_at)observation='provider-observed callback bridge and business From; receiver identity/audio unconfirmed'
 }else{
  const parent=await readCall(ctx,s.account,s.parentSid!),matches=await providerGet(ctx,s.account,'/Conferences.json?FriendlyName='+encodeURIComponent(s.conferenceName!)+'&Status=in-progress&PageSize=100')
  if(parent.direction!=='inbound'||parent.status!=='in-progress'||parent.from!==s.parentFrom||parent.to!==s.parentTo)throw new Fault('parent_identity_mismatch',502)
  if(!Array.isArray(matches.conferences)||matches.next_page_uri||matches.conferences.length!==1)throw new Fault('conference_membership_unconfirmed',409)
  const conference=matches.conferences[0] as Record<string,unknown>
  if(conference.account_sid!==s.account||conference.friendly_name!==s.conferenceName||conference.status!=='in-progress'||op.kind!=='park'&&conference.sid!==s.conferenceSid)throw new Fault('conference_identity_mismatch',502)
  const participants=await providerGet(ctx,s.account,'/Conferences/'+encodeURIComponent(String(conference.sid))+'/Participants.json?PageSize=100')
  if(!Array.isArray(participants.participants)||participants.next_page_uri)throw new Fault('conference_membership_unconfirmed',409)
  const rows=participants.participants as Record<string,unknown>[],expected=op.kind==='park'?[s.parentSid]:[s.parentSid,s.agentCallSid]
  if(rows.length!==expected.length||new Set(rows.map(r=>r.call_sid)).size!==expected.length||rows.some(p=>p.account_sid!==s.account||p.conference_sid!==conference.sid||p.status!=='connected'||p.muted!==false||p.hold!==false||p.coaching===true||!expected.includes(String(p.call_sid))))throw new Fault('conference_membership_unconfirmed',409)
  observation='provider-observed '+op.kind+' membership; human audio unconfirmed'
 }
 if(observation!=='unconfirmed')await append(env,op.actor,'frontdesk.'+op.kind,op.id,'completed',[...fences(),sql(env,"UPDATE hnd_frontdesk_operations SET state='provider_observed' WHERE id=?",op.id),sql(env,'UPDATE hnd_frontdesk_controls SET observed_at=?,observation=? WHERE operation_id=?',Date.now(),observation,op.id)],op.principal)
 return {operation:await operation(env,op.id),observation,customerOutcome:'unconfirmed',receiverAudio:'unqualified'}
}
