import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { Fault, id } from '../core'
import { capturePermission, carePrompt, getCall, getPolicy, guard, policyAuthority, type ConsentCall } from './store'
import { dispatchText, enqueueText } from './texts'

/** The one-reply decision and owned callback share the exact verified call.
 * Replayed status and DTMF callbacks cannot create another task or send. */
export async function missedCall(env:Bindings,call:ConsentCall,recordId:string,missedAt:number) {
 const existing=await env.DB.prepare('SELECT * FROM hnd_consent_outcomes WHERE call_id=?').bind(call.id).first()
 if(existing)return existing
 const policy=await getPolicy(env,call.policy_id),{source,fences}=await policyAuthority(env,policy)
 const record=await env.DB.prepare('SELECT case_id FROM hnd_records WHERE id=?').bind(recordId).first<{case_id:string}>()
 if(!record?.case_id)throw new Fault('verified_call_case_required',409)
 let permission=await env.DB.prepare('SELECT id,state FROM hnd_text_permissions WHERE call_id=? AND purpose=\'one_reply\'').bind(call.id).first<{id:string;state:string}>()
 if(!permission)permission=await capturePermission(env,call,'one_reply','declined',carePrompt(policy),{kind:'no_response',reason:'Call ended without explicit permission'})
 const now=Date.now(),prior=await env.DB.prepare('SELECT id FROM hnd_recovery WHERE case_id=?').bind(record.case_id).first<{id:string}>(),taskId=prior?.id??id(),reason=permission.state==='granted'?'Owned callback and one purpose-limited text queued':'Owned callback only; no text permission'
 const statements=[...fences,guard(env,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_consent_outcomes WHERE call_id=?) THEN 0 ELSE 1 END',call.id)]
 if(!prior)statements.push(env.DB.prepare('INSERT INTO hnd_recovery VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(taskId,record.case_id,source.id,recordId,null,'{}',call.caller,policy.approved_by,policy.owner_version,'open',missedAt+60000,1,reason,null,1,now,now),env.DB.prepare('INSERT INTO hnd_recovery_events VALUES (?,?,?,?,?,?)').bind(id(),taskId,'opened',JSON.stringify({callRecordId:recordId,consentId:permission.id}),source.id,now))
 statements.push(env.DB.prepare('INSERT INTO hnd_consent_outcomes VALUES (?,?,?,?,NULL,?)').bind(call.id,recordId,missedAt,taskId,reason))
 await append(env,source.id,'consent.missed',call.id,'completed',statements,null,sourcePolicy(source))
 if(permission.state==='granted') {
  const queued=await enqueueText(env,permission.id,`${policy.business_name}: We missed your call. Reply here for help about this call. Reply STOP to opt out.`,missedAt+60000)
  await env.DB.prepare('UPDATE hnd_consent_outcomes SET text_id=? WHERE call_id=?').bind(queued.id,call.id).run()
  const sent=await dispatchText(env,queued.id)
  await env.DB.prepare('UPDATE hnd_consent_outcomes SET reason=? WHERE call_id=?').bind(sent.reason,call.id).run()
 }
 return env.DB.prepare('SELECT * FROM hnd_consent_outcomes WHERE call_id=?').bind(call.id).first()
}
export async function observeMissedRecord(env:Bindings,sourceId:string,sid:string,recordId:string,at:number) {
 const call=await env.DB.prepare('SELECT id FROM hnd_consent_calls WHERE source_id=? AND call_sid=?').bind(sourceId,sid).first<{id:string}>()
 if(call)await missedCall(env,await getCall(env,call.id),recordId,at)
}
