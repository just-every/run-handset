import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { callUrl, readTwilio } from '../consent/store'
import { Fault, id, text } from '../core'
import { guard, sql } from '../delegation/store'
import { activeSourceById, sourceFence, type Source } from '../providers/sources'
import { intakeAuthority, intakeFence, intakePolicy, withinIntakeHours } from './intake-policy'

interface CallRecord {id:string;kind:string;parent_id:string|null;case_id:string|null;data:string}
const terminal=['completed','no-answer','busy','failed','canceled']
async function customerCall(env:Bindings, source:Source, recordId:string) {
 let current=recordId
 for(let depth=0;depth<12;depth++) {
  const row=await sql(env,`SELECT r.* FROM hnd_records r WHERE r.id=? AND EXISTS(SELECT 1 FROM hnd_record_sources rs JOIN hnd_sources s ON s.id=rs.source_id WHERE rs.record_id=r.id AND rs.source_kind='twilio' AND s.account_id=? AND s.number_id=?)`,current,source.account_id,source.number_id).first<CallRecord>()
  if(!row)return null
  if(row.kind==='call_session') {
   const objects=(await sql(env,'SELECT DISTINCT so.external_id FROM hnd_source_objects so JOIN hnd_sources s ON s.id=so.source_id WHERE so.record_id=? AND s.account_id=? AND s.number_id=?',row.id,source.account_id,source.number_id).all<{external_id:string}>()).results
   if(objects.length!==1)throw new Fault('recovery_call_identity_uncertain',409)
   return {row,sid:objects[0].external_id}
  }
  if(!['call_leg','provider_attempt'].includes(row.kind)||!row.parent_id)return null
  current=row.parent_id
 }
 throw new Fault('recovery_call_ancestry_uncertain',409)
}
async function answered(env:Bindings, source:Source, sid:string, caller:string, business:string) {
 const list=await readTwilio(env,source,`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(source.account_id)}/Calls.json?ParentCallSid=${encodeURIComponent(sid)}&PageSize=100`)
 if(!Array.isArray(list.calls)||list.calls.length>100||list.next_page_uri)throw new Fault('recovery_staff_readback_incomplete',409)
 // Re-read each child independently. A failed offer while the caller is still
 // waiting, a live child or an unknown duration never proves an unanswered call.
 for(let start=0;start<list.calls.length;start+=4) {
  const children=await Promise.all(list.calls.slice(start,start+4).map(async raw=>{
   const child=raw as Record<string,unknown>
   if(child.account_sid!==source.account_id||child.parent_call_sid!==sid)throw new Fault('recovery_child_identity_mismatch',502)
   return readTwilio(env,source,callUrl(source,text(child.sid,'childSid')))
  }))
  for(const child of children) {
   if(child.account_sid!==source.account_id||child.parent_call_sid!==sid||child.direction!=='outbound-dial'||![caller,business].includes(String(child.from)))throw new Fault('recovery_child_identity_mismatch',502)
   if(!terminal.includes(String(child.status)))throw new Fault('recovery_staff_outcome_uncertain',409)
   if(child.status==='completed') {
    if(!/^\d+$/.test(String(child.duration)))throw new Fault('recovery_staff_duration_required',409)
    if(Number(child.duration)>0)return true
   }
  }
 }
 return false
}

/** A current owner policy permits task intake only. It cannot mint contact
 * consent, create a callback attempt or change an existing human decision. */
export async function observeUnansweredCall(env:Bindings, sourceId:string, recordId:string) {
 const policy=await intakePolicy(env,sourceId)
 if(!policy)return
 const source=await activeSourceById(env,sourceId)
 if(!source||source.revision!==policy.source_revision)return
 const call=await customerCall(env,source,recordId)
 if(!call?.row.case_id)return
 const eventId='intake:'+source.id+':'+call.sid
 if(await sql(env,'SELECT id FROM hnd_recovery_events WHERE id=?',eventId).first())return
 const data=JSON.parse(call.row.data) as {direction?:string;from?:string;to?:string}
 if(data.direction!=='inbound')return
 const parent=await readTwilio(env,source,callUrl(source,call.sid))
 if(parent.sid!==call.sid||parent.account_sid!==source.account_id||parent.direction!=='inbound'||parent.parent_call_sid!==null||parent.from!==data.from||parent.to!==source.e164||data.to!==source.e164)throw new Fault('recovery_parent_identity_mismatch',502)
 if(!terminal.includes(String(parent.status)))return
 const missedAt=Date.parse(String(parent.end_time)),createdAt=Date.parse(String(parent.date_created))
 if(!Number.isFinite(missedAt)||!Number.isFinite(createdAt)||missedAt<createdAt||missedAt>Date.now()+1000)throw new Fault('recovery_outcome_time_required',409)
 // The carrier reports whole seconds. Approval and the outcome must share at
 // least that second; an older missed call is never backfilled by a new policy.
 if(missedAt<Math.floor(policy.created_at/1000)*1000||!withinIntakeHours(policy,missedAt))return
 if(await answered(env,source,call.sid,String(parent.from),source.e164))return
 const queue=(await sql(env,'SELECT id,queue_id,origin_queue_id,queued_at,priority,current_visit_id FROM hnd_queue_entries WHERE call_id=? ORDER BY queued_at LIMIT 1',call.row.id).first<{id:string}>())
 const stop=await sql(env,"SELECT id FROM hnd_protection_stops WHERE recipient=? AND (number_id=? OR reason='dnc') AND channel IN ('voice','all') LIMIT 1",String(parent.from),source.number_id).first()
 const previous=await sql(env,'SELECT id,state,revision,call_record_id,created_at FROM hnd_recovery WHERE case_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',call.row.case_id).first<{id:string;state:string;revision:number;call_record_id:string;created_at:number}>()
 const closed=previous&&['resolved','declined'].includes(previous.state)
 // Replays of earlier calls never create another need after its closure.
 if(closed&&await sql(env,"SELECT 1 FROM hnd_recovery_events WHERE recovery_id=? AND (json_extract(evidence,'$.customerCallId')=? OR json_extract(evidence,'$.callRecordId')=?)",previous.id,call.row.id,call.row.id).first())return
 const now=Date.now(),taskId=previous&&!closed?previous.id:id(),reason=stop?'Current opt-out or DNC; owned task only, no customer contact':'Owned missed-call task; this intake grants no text or calling permission'
 await append(env,source.id,'recovery.intake',call.row.case_id,'completed',[
  sourceFence(env,source),intakeFence(env,policy),guard(env,'SELECT count(*) FROM hnd_records WHERE id=? AND case_id=?',call.row.id,call.row.case_id),
  ...(previous?[guard(env,'SELECT count(*) FROM hnd_recovery WHERE id=? AND revision=?',previous.id,previous.revision)]:[]),
  ...(!previous||closed?[guard(env,"SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_recovery WHERE case_id=? AND state NOT IN ('resolved','declined')) THEN 0 ELSE 1 END",call.row.case_id)]:[]),
  sql(env,'INSERT INTO hnd_recovery VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',taskId,call.row.case_id,source.id,recordId,queue?.id??null,JSON.stringify(queue??{}),String(parent.from),policy.approved_by,policy.owner_version,stop?'stopped':'open',missedAt+60000,1,reason,null,1,now,now),
  ...(closed?[sql(env,'INSERT INTO hnd_recovery_links VALUES (?,?)',taskId,previous.id)]:[]),
  sql(env,`INSERT INTO hnd_recovery_events SELECT ?,r.id,'missed_observed',?,?,? FROM hnd_recovery r WHERE r.id=? ON CONFLICT(id) DO NOTHING`,eventId,JSON.stringify({callRecordId:recordId,customerCallId:call.row.id,callSid:call.sid,missedAt,observedAt:now,policyRevision:policy.revision,intakeGrantsContact:false,marketingEnrollment:false}),source.id,now,taskId),
 ],null,{...sourcePolicy(source),...intakeAuthority(policy)})
}
