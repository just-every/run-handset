import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { Fault, id } from '../core'
import { callUrl, capturePermission, carePrompt, getPolicy, guard, policyAuthority, readTwilio, type ConsentCall } from './store'
import { dispatchText, enqueueText } from './texts'

/** A caller can hang up inside Gather, before any staff Dial action exists.
 * Only an ended inbound parent with complete, empty child readback proves this path. */
export async function observeConsentDisconnect(env:Bindings,sourceId:string,sid:string,state:string,recordId:string) {
 if(!['completed','no-answer','busy','failed','canceled'].includes(state))return
 const call=await env.DB.prepare('SELECT * FROM hnd_consent_calls WHERE source_id=? AND call_sid=?').bind(sourceId,sid).first<ConsentCall>()
 if(!call||await env.DB.prepare("SELECT id FROM hnd_text_permissions WHERE call_id=? AND purpose='one_reply'").bind(call.id).first())return
 const policy=await getPolicy(env,call.policy_id),{source}=await policyAuthority(env,policy)
 const parent=await readTwilio(env,source,callUrl(source,sid))
 if(parent.sid!==sid||parent.account_sid!==source.account_id||parent.direction!=='inbound'||parent.parent_call_sid!==null||parent.from!==call.caller||parent.to!==call.business||parent.status!==state)throw new Fault('consent_disconnect_identity_mismatch',502)
 const missedAt=Date.parse(String(parent.end_time))
 if(!Number.isFinite(missedAt)||missedAt<Math.floor(call.created_at/1000)*1000||missedAt>Date.now()+1000)throw new Fault('missed_outcome_time_required',409)
 const children=await readTwilio(env,source,`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(source.account_id)}/Calls.json?ParentCallSid=${encodeURIComponent(sid)}&PageSize=100`)
 if(!Array.isArray(children.calls)||children.next_page_uri)throw new Fault('consent_disconnect_readback_incomplete',409)
 // A staff leg belongs to its independent Dial outcome, never an inferred disconnect.
 if(children.calls.length)return
 const permission=await capturePermission(env,call,'one_reply','declined',carePrompt(policy),{kind:'no_response',reason:'Caller ended before a consent decision',source:'signed terminal call callback and independent Twilio readback',serverTimestamp:Date.now()})
 if(permission.state!=='declined')return
 await missedCall(env,call,recordId,missedAt)
}

/** The one-reply decision and owned callback share the exact verified call.
 * Replayed status and DTMF callbacks cannot create another task or send. */
export async function missedCall(env:Bindings,call:ConsentCall,recordId:string,missedAt:number) {
 const existing=await env.DB.prepare('SELECT * FROM hnd_consent_outcomes WHERE call_id=?').bind(call.id).first()
 const policy=await getPolicy(env,call.policy_id),{source,fences}=await policyAuthority(env,policy)
 const record=await env.DB.prepare('SELECT case_id FROM hnd_records WHERE id=?').bind(recordId).first<{case_id:string}>()
 if(!record?.case_id)throw new Fault('verified_call_case_required',409)
 let permission=await env.DB.prepare('SELECT id,state FROM hnd_text_permissions WHERE call_id=? AND purpose=\'one_reply\'').bind(call.id).first<{id:string;state:string}>()
 if(!permission)permission=await capturePermission(env,call,'one_reply','declined',carePrompt(policy),{kind:'no_response',reason:'Call ended without explicit permission'})
 const now=Date.now(),prior=await env.DB.prepare('SELECT id FROM hnd_recovery WHERE case_id=?').bind(record.case_id).first<{id:string}>(),taskId=prior?.id??id(),reason=permission.state==='granted'?'Owned callback and one purpose-limited text queued':'Owned callback only; no text permission'
 const statements=[...fences,guard(env,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_consent_outcomes WHERE call_id=?) THEN 0 ELSE 1 END',call.id)]
 if(!existing&&!prior)statements.push(env.DB.prepare('INSERT INTO hnd_recovery VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(taskId,record.case_id,source.id,recordId,null,'{}',call.caller,policy.approved_by,policy.owner_version,'open',missedAt+60000,1,reason,null,1,now,now),env.DB.prepare('INSERT INTO hnd_recovery_events VALUES (?,?,?,?,?,?)').bind(id(),taskId,'opened',JSON.stringify({callRecordId:recordId,consentId:permission.id}),source.id,now))
 if(!existing)statements.push(env.DB.prepare('INSERT INTO hnd_consent_outcomes VALUES (?,?,?,?,NULL,?)').bind(call.id,recordId,missedAt,taskId,reason))
 if(!existing)await append(env,source.id,'consent.missed',call.id,'completed',statements,null,sourcePolicy(source))
 if(['granted','reserved','consumed'].includes(permission.state)) {
  const queued=await enqueueText(env,permission.id,`${policy.business_name}: We missed your call. Reply here for help about this call. Reply STOP to opt out.`,missedAt+60000)
  await env.DB.prepare('UPDATE hnd_consent_outcomes SET text_id=? WHERE call_id=?').bind(queued.id,call.id).run()
  const sent=await dispatchText(env,queued.id)
  await env.DB.prepare('UPDATE hnd_consent_outcomes SET reason=? WHERE call_id=?').bind(sent.reason,call.id).run()
 }
 return env.DB.prepare('SELECT * FROM hnd_consent_outcomes WHERE call_id=?').bind(call.id).first()
}
