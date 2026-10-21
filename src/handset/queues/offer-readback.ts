import { Fault } from '../core'
import { entry, entryGuard, event, queue, statement, write, type Context } from './storage'
import { boundSource, sourceContext } from './provider-proof'
import { callTerminal, cancelRinging, readCall, readChildren, type ProviderCall } from './provider-api'
import { offerById, offerGuard, type Offer } from './offers'
import { overflow } from './entries'
import { childRecords } from './provider-records'

export function destinationMatches(offer:Offer,to:string){
 return offer.destination_kind==='client'?to==='client:'+offer.destination:to===offer.destination||to===offer.destination.replace(/^sips?:/,'')
}
function verifyChild(offer:Offer,call:ProviderCall){
 const created=Date.parse(call.date_created)
 if(call.account_sid!==offer.account_id||call.parent_call_sid!==offer.parent_call_sid||call.direction!=='outbound-dial'||!destinationMatches(offer,call.to)||!Number.isFinite(created)||created<offer.emitted_at-1000)throw new Fault('queue_child_identity_mismatch',502)
 if(offer.child_call_sid&&call.sid!==offer.child_call_sid)throw new Fault('queue_offer_child_conflict',409)
}
export async function recoverOffer(original:Context,originalOffer:Offer,childSid?:string,negativeAction?:string){
 const source=await boundSource(original.env,originalOffer.binding_id)
 if(!source||source.source_id!==originalOffer.source_id||source.account_id!==originalOffer.account_id)throw new Fault('queue_source_authority_changed',409)
 const ctx:Context={...sourceContext(original.env,source),...(original.actor?{actor:original.actor}:{})}
 let offer=await offerById(ctx,originalOffer.id)
 if(childSid&&offer.child_call_sid&&childSid!==offer.child_call_sid)throw new Fault('queue_offer_child_conflict',409)
 const parent=await readCall(ctx,offer.account_id,offer.parent_call_sid)
 if(parent.direction!=='inbound'||parent.to!==JSON.parse(source.number_data).e164)throw new Fault('queue_parent_identity_mismatch',502)
 let child:ProviderCall|null=null
 const known=childSid??offer.child_call_sid
 if(known)child=await readCall(ctx,offer.account_id,known)
 else{
  const matches=(await readChildren(ctx,offer.account_id,offer.parent_call_sid)).filter(c=>destinationMatches(offer,c.to)&&Date.parse(c.date_created)>=offer.emitted_at-1000)
  if(matches.length>1)throw new Fault('queue_child_readback_ambiguous',409)
  if(matches[0])child=await readCall(ctx,offer.account_id,matches[0].sid)
 }
 if(child){verifyChild(offer,child);if(child.from!==parent.from)throw new Fault('queue_child_caller_mismatch',502)}
 if(['completed','failed'].includes(offer.state))return {offer,child,parent}
 if(offer.state==='active'&&child&&!callTerminal(child.status)&&child.status!=='in-progress')return {offer,child,parent}
 const row=await entry(ctx,offer.entry_id)
 if(row.current_visit_id!==offer.visit_id||!['reserved','active'].includes(row.state))throw new Fault('queue_offer_entry_conflict',409)
 if(!child){
  if(callTerminal(parent.status)||negativeAction&&['busy','failed','no-answer','canceled'].includes(negativeAction))await finish(ctx,offer,row,null,parent,negativeAction)
  return {offer:await offerById(ctx,offer.id),child,parent}
 }
 if(row.deadline_at<=Date.now()&&['queued','initiated','ringing'].includes(child.status)&&!offer.cancel_requested_at){
  await write(ctx,row.id,[offerGuard(ctx,offer),entryGuard(ctx,row),
   statement(ctx,'UPDATE hnd_queue_offers SET cancel_requested_at=?,revision=revision+1 WHERE id=?',Date.now(),offer.id),
   event(ctx,'offer.cancel_requested',offer.queue_id,row.id,offer.agent_id,{offerId:offer.id,transport:'uncertain',reason:'maximum_wait'}),
  ])
  await cancelRinging(ctx,offer.account_id,child.sid)
  offer=await offerById(ctx,offer.id)
  child=await readCall(ctx,offer.account_id,child.sid);verifyChild(offer,child)
 }
 if(callTerminal(child.status))await finish(ctx,offer,row,child,parent)
 else{
  const active=child.status==='in-progress',next=active?'active':'ringing'
  // Out-of-order ringing callbacks cannot regress a provider-observed active
  // assignment. The current GET, not callback labels, selects the transition.
  if(offer.state!==next||offer.child_call_sid!==child.sid){
   const now=Date.now()
   await write(ctx,row.id,[offerGuard(ctx,offer),entryGuard(ctx,row),...await childRecords(ctx,offer,row,child),
    statement(ctx,`UPDATE hnd_queue_offers SET state=?,child_call_sid=?,provider_status=?,observed_at=?,connected_at=CASE WHEN ?=1 THEN COALESCE(connected_at,?) ELSE connected_at END,revision=revision+1 WHERE id=?`,next,child.sid,child.status,now,active?1:0,now,offer.id),
    statement(ctx,`UPDATE hnd_queue_entries SET state=?,accepted_at=CASE WHEN ?=1 THEN COALESCE(accepted_at,?) ELSE accepted_at END,reason=?,revision=revision+1 WHERE id=?`,active?'active':'reserved',active?1:0,now,active?'provider_connected_audio_unconfirmed':'provider_ringing',row.id),
    ...(active?[statement(ctx,"UPDATE hnd_queue_reservations SET state='active' WHERE entry_id=?",row.id)]:[]),
    event(ctx,active?'offer.connected':'offer.ringing',offer.queue_id,row.id,offer.agent_id,{offerId:offer.id,transport:active?'connected':'ringing',audioReceipt:'unknown'},now),
   ])
  }
 }
 return {offer:await offerById(ctx,offer.id),child,parent}
}
async function finish(ctx:Context,offer:Offer,row:Awaited<ReturnType<typeof entry>>,child:ProviderCall|null,parent:ProviderCall,negativeAction?:string){
 const now=Date.now(),q=await queue(ctx,offer.queue_id),bridged=child?.status==='completed'
 const duration=bridged?Number(child!.duration):null
 if(duration!==null&&(!Number.isSafeInteger(duration)||duration<0||duration>86400))throw new Fault('invalid_queue_service_duration',502)
 const start=child?.start_time?Date.parse(child.start_time):NaN,end=child?.end_time?Date.parse(child.end_time):NaN
 if(bridged&&(!Number.isFinite(start)||!Number.isFinite(end)||end<start||start<Date.parse(child!.date_created)||(duration??0)>Math.ceil((end-start)/1000)))throw new Fault('queue_service_timestamp_required',502)
 const abandoned=callTerminal(parent.status)&&!bridged,next=bridged?'completed':abandoned?'abandoned':'waiting'
 await write(ctx,row.id,[offerGuard(ctx,offer),entryGuard(ctx,row),...(child?await childRecords(ctx,offer,row,child):[]),
  statement(ctx,'UPDATE hnd_queue_offers SET state=?,child_call_sid=?,provider_status=?,observed_at=?,connected_at=?,completed_at=?,service_seconds=?,revision=revision+1 WHERE id=?',bridged?'completed':'failed',child?.sid??null,child?.status??negativeAction??parent.status,now,bridged?start:offer.connected_at,bridged?end:now,duration,offer.id),
  statement(ctx,'DELETE FROM hnd_queue_reservations WHERE entry_id=?',row.id),
  statement(ctx,'UPDATE hnd_queue_entries SET state=?,agent_id=CASE WHEN ?=1 THEN agent_id ELSE NULL END,accepted_at=CASE WHEN ?=1 THEN COALESCE(accepted_at,?) ELSE accepted_at END,ended_at=?,reason=?,revision=revision+1 WHERE id=?',next,bridged?1:0,bridged?1:0,bridged?start:now,next==='waiting'?null:now,bridged?'provider_completed_audio_unconfirmed':abandoned?'provider_reported_abandon':'provider_offer_failed',row.id),
  statement(ctx,'UPDATE hnd_queue_agents SET idle_since=?,wrap_until=CASE WHEN wrap_until>? THEN wrap_until ELSE ? END,revision=revision+1 WHERE operator_id=?',now,bridged?now+q.wrap_seconds*1000:0,bridged?now+q.wrap_seconds*1000:0,offer.agent_id),
  ...(bridged&&duration!==null&&duration>0?[statement(ctx,'INSERT INTO hnd_queue_service_observations VALUES (?,?,?,?,?,?)',offer.id,q.id,row.language,row.skills,duration!,now)]:[]),
  event(ctx,bridged?'offer.completed':abandoned?'entry.abandoned':'offer.failed',q.id,row.id,offer.agent_id,{offerId:offer.id,transport:child?.status??'parent ended',audioReceipt:'unknown',serviceSeconds:duration,wrapUntil:bridged?now+q.wrap_seconds*1000:null},now),
 ])
 if(!bridged&&!abandoned)await overflow(ctx,await entry(ctx,row.id),q,row.deadline_at<=now?'maximum_wait':'agent_offer_failed',now)
}
