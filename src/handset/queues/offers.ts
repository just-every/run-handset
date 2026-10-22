import { escape as e, Fault, id } from '../core'
import { entryGuard, event, guard, queue, statement, write, type Context } from './storage'
import { presenceFreshMs, type Entry } from './model'
import type { BoundSource } from './provider-proof'
import type { AgentRoute } from './media-policy'

export interface Offer {
 id:string;entry_id:string;visit_id:string;queue_id:string;agent_id:string;binding_id:string;source_id:string;account_id:string;parent_call_sid:string;
 destination_kind:'client'|'sip';destination:string;route_revision:number;state:'uncertain'|'ringing'|'active'|'completed'|'failed';
 child_call_sid:string|null;emitted_at:number;observed_at:number|null;connected_at:number|null;completed_at:number|null;service_seconds:number|null;
 provider_status:string|null;cancel_requested_at:number|null;revision:number
}
export const currentOffer=(ctx:Context,row:Entry)=>statement(ctx,'SELECT * FROM hnd_queue_offers WHERE visit_id=?',row.current_visit_id).first<Offer>()
export async function offerById(ctx:Context,offerId:string){
 const offer=await statement(ctx,'SELECT * FROM hnd_queue_offers WHERE id=?',offerId).first<Offer>()
 if(!offer)throw new Fault('queue_offer_not_found',404)
 return offer
}
export const offerGuard=(ctx:Context,offer:Offer)=>guard(ctx,'SELECT count(*) FROM hnd_queue_offers WHERE id=? AND revision=?',offer.id,offer.revision)
export async function emitOffer(ctx:Context,source:BoundSource,row:Entry,parentSid:string){
 if(row.state!=='reserved'||!row.agent_id||!row.current_visit_id)throw new Fault('entry_not_reserved',409)
 if(await currentOffer(ctx,row))throw new Fault('queue_offer_already_emitted',409)
 const route=await statement(ctx,`SELECT r.* FROM hnd_queue_agent_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.operator_id=? AND r.source_id=? AND r.revoked_at IS NULL AND o.status='active' AND o.role='owner'`,row.agent_id,source.source_id).first<AgentRoute>()
 if(!route)throw new Fault('queue_agent_route_unqualified',409)
 const now=Date.now(),q=await queue(ctx,row.queue_id),remaining=Math.floor((row.deadline_at-now)/1000)
 // Twilio imposes a five-second minimum and adds five seconds to Dial timeout.
 // Leave a control/audio margin; actual audio latency requires receiver qualification.
 if(remaining<20)throw new Fault('queue_dial_deadline_too_close',409)
 const timeout=Math.min(30,remaining-15),target=id()
 await write(ctx,row.id,[entryGuard(ctx,row),
  guard(ctx,'SELECT count(*) FROM hnd_queues WHERE id=? AND revision=?',q.id,q.revision),
  guard(ctx,`SELECT count(*) FROM hnd_queue_agent_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.operator_id=? AND r.source_id=? AND r.revision=? AND r.revoked_at IS NULL AND o.status='active' AND o.role='owner'`,row.agent_id,source.source_id,route.revision),
  guard(ctx,`SELECT count(*) FROM hnd_queue_agents a JOIN hnd_queue_memberships m ON m.operator_id=a.operator_id JOIN oa_operators o ON o.id=a.operator_id WHERE a.operator_id=? AND a.availability='available' AND a.heartbeat_at>? AND a.wrap_until<=? AND o.status='active' AND m.queue_id=? AND m.logged_in=1`,row.agent_id,now-presenceFreshMs,now,q.id),
  guard(ctx,"SELECT count(*) FROM hnd_queue_reservations WHERE entry_id=? AND agent_id=? AND state='reserved' AND lease_until>?",row.id,row.agent_id,now),
  statement(ctx,`INSERT INTO hnd_queue_offers(id,entry_id,visit_id,queue_id,agent_id,binding_id,source_id,account_id,parent_call_sid,destination_kind,destination,route_revision,state,emitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'uncertain',?)`,target,row.id,row.current_visit_id,q.id,row.agent_id,source.id,source.source_id,source.account_id,parentSid,route.kind,route.destination,route.revision,now),
  statement(ctx,"UPDATE hnd_queue_entries SET reason='provider_offer_uncertain',revision=revision+1 WHERE id=?",row.id),
  event(ctx,'offer.emitted',q.id,row.id,row.agent_id,{offerId:target,routeRevision:route.revision,targetKind:route.kind,transport:'uncertain',audioReceipt:'unknown'}),
 ])
 const base=ctx.env.AUTH_ORIGIN+'/providers/twilio/queues/'+source.id+'/offers/'+target
 const noun=route.kind==='client'?'Client':'Sip'
 return `<Dial answerOnBridge="true" timeout="${timeout}" action="${e(base+'/action')}" method="POST"><${noun} statusCallback="${e(base+'/status')}" statusCallbackMethod="POST" statusCallbackEvent="initiated ringing answered completed">${e(route.destination)}</${noun}></Dial>`
}
