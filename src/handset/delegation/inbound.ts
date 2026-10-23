import type { Bindings } from '../../auth.server'
import { actorRef, append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { escape as e, Fault, id } from '../core'
import type { ChallengeContext } from '../protection/challenges'
import { sourceFence } from '../protection/carrier-proof'
import { destination, overflowUrl } from '../queues/media-policy'
import { delegationFence, guard, linePolicy, sql, type Delegation, type Line } from './store'
import { endpointFence, inboundRouteFence, lineFence, type InboundRoute } from './inbound-policy'

/** Continue only the authenticated existing inbound call. A durable uncertain
 * receipt is written before returning TwiML; a retry cannot issue another Dial.
 * Twilio schemas: /docs/voice/twiml/{dial,number,sip,client,redirect}. */
export async function executiveContinuation(env:Bindings,c:ChallengeContext,fences:D1PreparedStatement[]){
 const lines=(await sql(env,'SELECT * FROM hnd_frontdesk_lines WHERE source_id=? AND number_id=?',c.source.id,c.source.number_id).all<Line>()).results
 if(!lines.length)return null
 if(lines.length!==1)throw new Fault('ambiguous_executive_line',409)
 const l=lines[0],policy=linePolicy(l),routing=await sql(env,'SELECT * FROM hnd_frontdesk_routing WHERE line_id=?',l.id).first<InboundRoute>()
 const guardList=[...fences,sourceFence(env,c.source),lineFence(env,l)]
 let branch='principal',body=`<Redirect method="POST">${e(c.route.continuation_url)}</Redirect>`,d:Delegation|null=null
 if(policy.forwardTo||!policy.withinHours||policy.dnd){
  if(!routing||routing.line_revision!==l.revision||routing.expires_at<=Date.now())throw new Fault('executive_inbound_route_unapproved',409)
  guardList.push(inboundRouteFence(env,routing))
  const voicemail=()=>`<Redirect method="POST">${e(overflowUrl(routing.voicemail_url,env.AUTH_ORIGIN))}</Redirect>`
  if(policy.forwardTo){
   if(policy.forwardTo===c.to||!/^\+[1-9]\d{7,14}$/.test(policy.forwardTo))throw new Fault('invalid_forwarding_destination',409)
   branch='external_forward'
   body=`<Dial timeout="15" timeLimit="${routing.max_seconds}" record="do-not-record" callerId="${e(c.to)}"><Number>${e(policy.forwardTo)}</Number></Dial><Hangup/>`
  }else if(!policy.withinHours){branch='outside_hours_voicemail';body=voicemail()}
  else{
   branch='dnd_voicemail';body=voicemail()
   if(routing.delegation_id){
    const candidate=await sql(env,'SELECT * FROM hnd_delegations WHERE id=? AND line_id=?',routing.delegation_id,l.id).first<Delegation>()
    if(candidate){
     const endpoint=await sql(env,`SELECT r.* FROM hnd_queue_agent_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.operator_id=? AND r.source_id=? AND r.revision=? AND r.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=r.owner_version`,candidate.assistant_id,c.source.id,routing.endpoint_revision).first<{kind:'client'|'sip';destination:string}>()
     const scoped=delegationFence(env,candidate.assistant_id,candidate,l)
     try{
      await env.DB.batch([scoped,sql(env,'DELETE FROM hnd_guard')])
      if(endpoint&&endpoint.kind===routing.endpoint_kind&&endpoint.destination===routing.endpoint_destination){
       d=candidate;branch='dnd_assistant'
       guardList.push(delegationFence(env,d.assistant_id,d,l),endpointFence(env,d.assistant_id,c.source.id,routing.endpoint_revision!))
       const noun=endpoint.kind==='sip'?'Sip':'Client',target=destination(endpoint.kind,endpoint.destination)
       body=`<Dial timeout="15" timeLimit="${routing.max_seconds}" record="do-not-record" callerId="${e(c.to)}"><${noun}>${e(target)}</${noun}></Dial><Hangup/>`
      }
     }catch(error){if(!String(error).includes('CHECK constraint failed'))throw error}
    }
   }
  }
 }
 if(await sql(env,'SELECT id FROM hnd_frontdesk_inbound WHERE source_id=? AND call_sid=?',c.source.id,c.callId).first())throw new Fault('executive_inbound_already_started',409)
 const subject=id(),principal=await actorRef(env.DB,l.principal_id)
 await append(env,c.source.id,'frontdesk.route',subject,'uncertain',[
  ...guardList,
  guard(env,'SELECT count(*)=0 FROM hnd_frontdesk_inbound WHERE source_id=? AND call_sid=?',c.source.id,c.callId),
  sql(env,'INSERT INTO hnd_frontdesk_inbound VALUES (?,?,?,?,?,?,?,?)',subject,c.source.id,c.callId,l.id,l.revision,routing?.revision??null,branch,Date.now()),
 ],principal,{...sourcePolicy(c.source),line:{id:l.id,revision:l.revision,ownerVersion:l.owner_version},...(branch!=='principal'&&routing?{route:{id:routing.id,revision:routing.revision,ownerVersion:routing.owner_version}}:{}),...(d?{delegation:{id:d.id,revision:1,ownerVersion:d.owner_version}}:{})})
 return body
}
