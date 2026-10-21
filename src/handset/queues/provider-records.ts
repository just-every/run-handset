import { Fault, id } from '../core'
import { statement, type Context } from './storage'
import type { Entry } from './model'
import type { Offer } from './offers'
import type { ProviderCall } from './provider-api'

/** Canonical leg identity stays shared with the existing signed event source.
 * Later provider status observations append; the original leg is immutable. */
export async function childRecords(ctx:Context,offer:Offer,row:Entry,call:ProviderCall){
 const existing=await statement(ctx,'SELECT record_id FROM hnd_source_objects WHERE source_id=? AND external_id=?',offer.source_id,call.sid).first<{record_id:string}>()
 const parent=await statement(ctx,'SELECT case_id FROM hnd_records WHERE id=?',row.call_id).first<{case_id:string|null}>()
 if(!parent?.case_id)throw new Fault('queue_parent_case_required',409)
 const recordId=id(),received=Date.now(),occurred=Date.parse(call.date_created)
 if(!Number.isFinite(occurred))throw new Fault('queue_child_timestamp_required',502)
 let parentId=row.call_id
 if(existing){
  const record=await statement(ctx,'SELECT kind,parent_id FROM hnd_records WHERE id=?',existing.record_id).first<{kind:string;parent_id:string|null}>()
  if(record?.kind!=='call_leg'||record.parent_id!==row.call_id)throw new Fault('queue_child_record_conflict',409)
  parentId=existing.record_id
 }
 const eventId='queue-offer:'+offer.id+':'+offer.revision+':'+call.status
 const data={direction:'outbound',providerStatus:call.status,from:call.from,to:call.to,parentCallSid:call.parent_call_sid,offerId:offer.id,visitId:offer.visit_id,customerOutcome:'unconfirmed',audioReceipt:'unknown',...(existing?{operation:'provider_readback',objectKind:'call_leg'}:{}),...(call.status==='completed'?{durationSeconds:Number(call.duration)}:{})}
 return [
  statement(ctx,'INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)',recordId,existing?'provider_attempt':'call_leg','native',offer.source_id+':'+eventId,occurred,received,parent.case_id,parentId,null,JSON.stringify(data),offer.source_id),
  statement(ctx,'INSERT INTO hnd_record_sources VALUES (?,?,?,?)',recordId,offer.source_id,'twilio',eventId),
  ...(!existing?[statement(ctx,'INSERT INTO hnd_source_objects VALUES (?,?,?,?)',offer.source_id,call.sid,recordId,parent.case_id)]:[]),
 ]
}
