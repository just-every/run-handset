import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { Fault, id, text, digest } from '../core'
import { activeSourceById, sourceFence } from '../providers/sources'

export interface ConsentCall { id:string; source_id:string; policy_id:string; call_sid:string; leg_sid:string; caller:string; business:string; identity:string; created_at:number }
export interface Permission { id:string; call_id:string; purpose:'one_reply'|'survey'; state:string; prompt:string; event:string; created_at:number }
export interface ConsentPolicy { id:string; source_id:string; revision:number; business_name:string; legal_configuration:string; registration_id:string; staff_target:string; approved_by:string; owner_version:number; created_at:number; expires_at:number; revoked_at:number|null }
export const guard=(env:Bindings,query:string,...values:(string|number|null)[])=>env.DB.prepare('INSERT INTO hnd_guard(ok) '+query).bind(...values)
export async function getCall(env:Bindings,key:string) {
 const row=await env.DB.prepare('SELECT * FROM hnd_consent_calls WHERE id=?').bind(key).first<ConsentCall>()
 if(!row)throw new Fault('consent_call_not_found',404)
 return row
}
export async function getPolicy(env:Bindings,key:string) {
 const row=await env.DB.prepare('SELECT * FROM hnd_consent_policies WHERE id=?').bind(key).first<ConsentPolicy>()
 if(!row)throw new Fault('reviewed_consent_policy_required',409)
 return row
}
export async function policyAuthority(env:Bindings,p:ConsentPolicy) {
 const source=await activeSourceById(env,p.source_id)
 if(!source)throw new Fault('consent_source_inactive',409)
 const fence=guard(env,`SELECT count(*) FROM hnd_consent_policies p JOIN oa_operators o ON o.id=p.approved_by WHERE p.id=? AND p.revoked_at IS NULL AND p.expires_at>? AND o.role='owner' AND o.status='active' AND o.version=p.owner_version AND NOT EXISTS(SELECT 1 FROM hnd_consent_policies newer WHERE newer.source_id=p.source_id AND newer.revision>p.revision)`,p.id,Date.now())
 try { await env.DB.batch([sourceFence(env,source),fence,env.DB.prepare('DELETE FROM hnd_guard')]) }
 catch { throw new Fault('consent_policy_not_current',409) }
 return {source,fences:[sourceFence(env,source),fence]}
}
export async function readTwilio(env:Bindings,source:{account_id:string},url:string) {
 const u=new URL(url)
 if(!['api.twilio.com','messaging.twilio.com'].includes(u.hostname)||u.protocol!=='https:'||u.username||u.password||u.hash||!env.HANDSET_TWILIO_AUTH_TOKEN)throw new Fault('invalid_provider_address',503)
 let response:Response
 try { response=await fetch(url,{headers:{authorization:'Basic '+btoa(source.account_id+':'+env.HANDSET_TWILIO_AUTH_TOKEN)},redirect:'manual',signal:AbortSignal.timeout(5000)}) }
 catch { throw new Fault('consent_provider_unavailable',503) }
 if(response.status!==200)throw new Fault('consent_provider_unavailable',503)
 try { return await response.json() as Record<string,unknown> } catch { throw new Fault('invalid_provider_receipt',502) }
}
export const callUrl=(source:{account_id:string},sid:string)=>`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(source.account_id)}/Calls/${encodeURIComponent(sid)}.json`
export async function ensureCall(env:Bindings,sourceId:string,p:URLSearchParams):Promise<ConsentCall> {
 const latest=await env.DB.prepare('SELECT * FROM hnd_consent_policies WHERE source_id=? ORDER BY revision DESC LIMIT 1').bind(sourceId).first<ConsentPolicy>()
 if(!latest)throw new Fault('reviewed_consent_policy_required',409)
 const {source,fences}=await policyAuthority(env,latest)
 const sid=text(p.get('CallSid'),'CallSid'),caller=text(p.get('From'),'From',40),business=text(p.get('To'),'To',40)
 if(p.get('AccountSid')!==source.account_id||business!==source.e164)throw new Fault('caller_identity_unclear',409)
 const receipt=await readTwilio(env,source,callUrl(source,sid))
 if(receipt.sid!==sid||receipt.account_sid!==source.account_id||receipt.from!==caller||receipt.to!==business||receipt.direction!=='inbound'||!['ringing','in-progress'].includes(String(receipt.status)))throw new Fault('existing_inbound_call_required',409)
 const old=await env.DB.prepare('SELECT * FROM hnd_consent_calls WHERE source_id=? AND call_sid=?').bind(sourceId,sid).first<ConsentCall>()
 if(old) {
  if(old.caller!==caller||old.business!==business||old.policy_id!==latest.id)throw new Fault('consent_call_context_changed',409)
  if(old.identity==='unverified_observed_number'&&p.get('StirVerstat')==='TN-Validation-Passed'&&/^\+[1-9]\d{7,14}$/.test(caller)) {
   await append(env,source.id,'consent.identity',old.id,'completed',[...fences,env.DB.prepare("UPDATE hnd_consent_calls SET identity='provider_validated_number' WHERE id=?").bind(old.id)],null,sourcePolicy(source))
   old.identity='provider_validated_number'
  }
  return old
 }
 // An observed E.164 caller is not a verified person. Only provider-validated
 // calling-number confidence qualifies automatic contact; unknown stays held.
 const identity=p.get('StirVerstat')==='TN-Validation-Passed'&&/^\+[1-9]\d{7,14}$/.test(caller)?'provider_validated_number':'unverified_observed_number'
 const row:ConsentCall={id:id(),source_id:sourceId,policy_id:latest.id,call_sid:sid,leg_sid:sid,caller,business,identity,created_at:Date.now()}
 const statements=[...fences,env.DB.prepare('INSERT INTO hnd_consent_calls VALUES (?,?,?,?,?,?,?,?,?,?)').bind(...Object.values(row))]
 const existing=await env.DB.prepare('SELECT record_id FROM hnd_source_objects WHERE source_id=? AND external_id=?').bind(source.id,sid).first()
 if(!existing) {
  const correlation=await digest([source.account_id,source.number_id,business,caller])
  const prior=await env.DB.prepare('SELECT case_id FROM hnd_source_cases WHERE source_id=? AND correlation=?').bind(source.id,correlation).first<{case_id:string}>()
  const caseId=prior?.case_id??id(),recordId=id(),now=Date.now()
  if(!prior)statements.push(env.DB.prepare('INSERT INTO hnd_cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(caseId,'Communication with '+caller,latest.approved_by,null,'','open',0,1,1,latest.approved_by,now,''),env.DB.prepare('INSERT INTO hnd_source_cases VALUES (?,?,?)').bind(source.id,correlation,caseId))
  const occurred=Date.parse(String(receipt.start_time??receipt.date_created))
  if(!Number.isFinite(occurred))throw new Fault('provider_time_unavailable',503)
  statements.push(env.DB.prepare('INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(recordId,'call_session','native','consent:'+row.id,occurred,now,caseId,null,null,JSON.stringify({from:caller,to:business,direction:'inbound',providerStatus:receipt.status,customerOutcome:'unconfirmed'}),source.id),env.DB.prepare('INSERT INTO hnd_record_sources VALUES (?,?,?,?)').bind(recordId,source.id,'twilio','consent:'+sid),env.DB.prepare('INSERT INTO hnd_source_objects VALUES (?,?,?,?)').bind(source.id,sid,recordId,caseId))
 }
 await append(env,source.id,'consent.call',row.id,'completed',statements,null,sourcePolicy(source))
 return row
}
export async function capturePermission(env:Bindings,call:ConsentCall,purpose:'one_reply'|'survey',decision:'granted'|'declined',prompt:string,event:Record<string,unknown>):Promise<Permission> {
 const policy=await getPolicy(env,call.policy_id),{source,fences}=await policyAuthority(env,policy)
 const old=await env.DB.prepare('SELECT * FROM hnd_text_permissions WHERE call_id=? AND purpose=?').bind(call.id,purpose).first<Permission>()
 if(old)return old
 const row:Permission={id:id(),call_id:call.id,purpose,state:decision,prompt,event:JSON.stringify({...event,promptVersion:policy.id,caller:call.caller,identity:call.identity,business:call.business,callSid:call.call_sid,legSid:call.leg_sid,purpose,scope:purpose==='one_reply'?'one customer-care reply; no marketing':'one optional survey; no marketing',legalConfiguration:policy.legal_configuration,legalBasis:'explicit caller permission for the declared informational purpose',marketingEnrollment:false}),created_at:Date.now()}
 await append(env,source.id,'consent.capture',row.id,'completed',[...fences,env.DB.prepare('INSERT INTO hnd_text_permissions VALUES (?,?,?,?,?,?,?,NULL)').bind(...Object.values(row))],null,sourcePolicy(source))
 return row
}
export const carePrompt=(p:ConsentPolicy)=>`${p.business_name}: Press 1 to receive one customer-care text about this call. This is optional and does not sign you up for marketing. Press 2 or wait to continue without a text.`
