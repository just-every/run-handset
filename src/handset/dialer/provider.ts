import { runtimeBindings, type Bindings } from '../../auth.server'
import { escape as e, Fault, json } from '../core'
import { verifyQueueRequest } from '../queues/provider-proof'
import { waitingAgent } from './network'
import { listEligibility, recipientEligibility } from './eligibility'
import { attempt, event, guard, list, recipients, sql, write, type Context } from './storage'
import { reconcileAttempt } from './readback'
import type { Ready } from './model'
const xml=(body:string)=>new Response('<Response>'+body+'</Response>',{headers:{'content-type':'text/xml; charset=utf-8','cache-control':'no-store'}})
async function instructions(ctx:Context,attemptId:string){
 const a=await attempt(ctx,attemptId),l=await list(ctx,a.list_id)
 if(a.bridge_emitted_at)throw new Fault('dialer_bridge_already_emitted',409)
 if(['completed','failed','held'].includes(a.state))return xml('<Hangup/>')
 let eligibility:Awaited<ReturnType<typeof listEligibility>>
 try{
  eligibility=await listEligibility(ctx,l,a.mode)
  const recipient=(await recipients(ctx,l.id)).find(r=>r.ordinal===a.ordinal)!
  await recipientEligibility(ctx,l,recipient,a.mode,eligibility.policy,a.id)
  // A reservation survives a pause. At answer, the preconnected agent must
  // still be staffed and in its exact one-agent conference, without new Dial.
  const now=Date.now(),ready=await sql(ctx,"SELECT r.* FROM hnd_dialer_ready r JOIN oa_operators o ON o.id=r.approved_by WHERE r.agent_id=? AND r.agent_call_sid=? AND r.expires_at>? AND o.status='active' AND o.version=r.owner_version AND (o.role='owner' OR r.approved_by=r.agent_id)",a.agent_id,a.agent_call_sid,now).first<Ready>()
  const present=await sql(ctx,`SELECT a.operator_id FROM hnd_queue_agents a JOIN hnd_queue_memberships m ON m.operator_id=a.operator_id JOIN oa_operators o ON o.id=a.operator_id WHERE a.operator_id=? AND a.availability='available' AND a.heartbeat_at>? AND m.queue_id=? AND m.logged_in=1 AND o.status='active'`,a.agent_id,now-90000,l.queue_id).first()
  const reservation=await sql(ctx,'SELECT attempt_id FROM hnd_dialer_reservations WHERE attempt_id=? AND agent_id=?',a.id,a.agent_id).first()
  const route=await sql(ctx,'SELECT destination FROM hnd_queue_agent_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.operator_id=? AND r.source_id=? AND r.revoked_at IS NULL AND o.status=\'active\' AND o.role=\'owner\'',a.agent_id,l.source_id).first<{destination:string}>()
  if(!ready||!present||!reservation||!route)throw new Fault('waiting_agent_unavailable',409)
  await waitingAgent(ctx,a.account_id,ready,route.destination)
  const recipientFences=await recipientEligibility(ctx,l,recipient,a.mode,eligibility.policy,a.id)
  await write(ctx,a.id,[...eligibility.fences,...recipientFences,guard(ctx,'SELECT count(*) FROM hnd_dialer_attempts WHERE id=? AND bridge_emitted_at IS NULL',a.id),guard(ctx,'SELECT count(*) FROM hnd_dialer_ready WHERE agent_id=? AND agent_call_sid=? AND expires_at>?',a.agent_id,a.agent_call_sid,Date.now()),sql(ctx,'UPDATE hnd_dialer_attempts SET bridge_emitted_at=?,version=version+1 WHERE id=?',Date.now(),a.id),event(ctx,'attempt.bridge_instructions',l.id,a.session_id,a.id,{conferenceSid:a.conference_sid,disclosure:eligibility.policy.disclosure,disclosureResponsibility:'preconnected human agent; no prerecorded marketing',audioReceipt:'pending'})])
  // The agent is already connected. No customer waits for an agent phone to
  // ring, and no recorded sales pitch consumes the connection deadline.
  return xml(`<Dial action="${e(ctx.env.AUTH_ORIGIN+'/providers/twilio/dialer/'+a.id+'/status')}" method="POST"><Conference beep="false" startConferenceOnEnter="false" endConferenceOnExit="true" waitUrl="">${e(a.conference_name)}</Conference></Dial>`)
 }catch(error){
  if(!(error instanceof Fault))throw error
  const q=await sql(ctx,'SELECT definition FROM hnd_dialer_qualifications WHERE id=?',l.qualification_id).first<{definition:string}>(),message=q?JSON.parse(q.definition).abandonMessage:''
  await write(ctx,a.id,[guard(ctx,'SELECT count(*) FROM hnd_dialer_attempts WHERE id=? AND bridge_emitted_at IS NULL',a.id),sql(ctx,"UPDATE hnd_dialer_attempts SET reason='agent_unavailable_message',disposition='abandoned',bridge_emitted_at=?,version=version+1 WHERE id=?",Date.now(),a.id),sql(ctx,"UPDATE hnd_dialer_sessions SET state='paused',reason=?,revision=revision+1 WHERE list_id=? AND state='running'",error.code,l.id),event(ctx,'attempt.safety_message',l.id,a.session_id,a.id,{reason:error.code,instructionsEmitted:true,audioDelivery:'unproven'})])
  return xml((message?'<Say>'+e(message)+'</Say>':'')+'<Hangup/>')
 }
}
export async function dialerProviderResponse(request:Request,original:Bindings):Promise<Response|null>{
 const url=new URL(request.url),match=url.pathname.match(/^\/providers\/twilio\/dialer\/([^/]+)\/(answer|status)$/)
 if(!match)return null
 const env=runtimeBindings(original)
 try{
  if(url.origin!==env.AUTH_ORIGIN||url.search||request.headers.has('host')&&request.headers.get('host')?.toLowerCase()!==url.host.toLowerCase())throw new Fault('invalid_dialer_source_proof',403)
  if(request.method!=='POST')throw new Fault('method_not_allowed',405)
  if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new Fault('invalid_source_content_type',415)
  const raw=await request.text();if(new TextEncoder().encode(raw).length>65536)throw new Fault('body_too_large',413)
  const p=new URLSearchParams(raw);await verifyQueueRequest(request,env,p)
  const row=await attempt({env},match[1]),l=await list({env},row.list_id),ctx:Context={env,auditActor:l.source_id}
  if(p.get('AccountSid')!==row.account_id||p.get('From')!==row.from_number||p.get('To')!==row.recipient||!p.get('CallSid'))throw new Fault('dialer_source_scope_mismatch',403)
  await reconcileAttempt(ctx,row,p.get('CallSid')!)
  if(match[2]==='answer')return instructions(ctx,row.id)
  return xml('')
 }catch(error){if(error instanceof Fault)return json({error:error.code},error.status);return json({error:'dialer_provider_unavailable'},503)}
}
