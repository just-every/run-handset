import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { Fault } from '../core'
import { guard, sql } from '../delegation/store'
import { getCall, getPolicy, policyAuthority, readTwilio } from '../consent/store'
import { getText } from '../consent/texts'
export interface Invitation {id:string;call_record_id:string;case_id:string;call_id:string;source_id:string;channel:'ivr'|'sms';created_by:string;owner_version:number;created_at:number;expires_at:number;permission_id:string|null;text_id:string|null;eligible_at:number|null;suppressed_at:number|null;suppression_reason:string}
export async function context(env:Bindings,target:string){
 const invitation=await sql(env,'SELECT * FROM hnd_survey_invitations WHERE id=?',target).first<Invitation>()
 if(!invitation)throw new Fault('survey_not_found',404)
 const call=await getCall(env,invitation.call_id),policy=await getPolicy(env,call.policy_id),authority=await policyAuthority(env,policy)
 if(call.source_id!==invitation.source_id||authority.source.id!==invitation.source_id)throw new Fault('survey_source_changed',409)
 const fences=[...authority.fences,guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND role='owner' AND status='active'",invitation.created_by,invitation.owner_version)]
 await env.DB.batch([...fences,sql(env,'DELETE FROM hnd_guard')])
 return {invitation,call,policy,source:authority.source,fences}
}
export type Context=Awaited<ReturnType<typeof context>>
export async function change(env:Bindings,c:Context,action:string,statements:D1PreparedStatement[]){
 await append(env,c.source.id,action,c.invitation.id,'completed',[...c.fences,...statements],null,sourcePolicy(c.source))
}
export async function syncDelivery(env:Bindings,c:Context){
 const i=c.invitation
 if(!i.text_id||i.channel!=='sms'||i.eligible_at||i.suppressed_at)return
 const message=await getText(env,i.text_id)
 if(['suppressed','failed','expired','blocked'].includes(message.state)){
  await change(env,c,'survey.suppress',[sql(env,"UPDATE hnd_survey_invitations SET suppressed_at=COALESCE(suppressed_at,?),suppression_reason=? WHERE id=? AND eligible_at IS NULL",Date.now(),message.reason||message.state,i.id)])
  i.suppressed_at=Date.now();return
 }
 if(!message.provider_sid)return
 const receipt=await readTwilio(env,c.source,`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.source.account_id)}/Messages/${message.provider_sid}.json`)
 if(receipt.sid!==message.provider_sid||receipt.account_sid!==c.source.account_id||receipt.from!==c.call.business||receipt.to!==c.call.caller||receipt.body!==message.body||!['outbound-api','outbound-reply'].includes(String(receipt.direction)))throw new Fault('survey_delivery_identity_mismatch',502)
 if(receipt.status==='delivered'){
  const now=Date.now()
  await change(env,c,'survey.deliver',[sql(env,'UPDATE hnd_survey_invitations SET eligible_at=COALESCE(eligible_at,?) WHERE id=? AND suppressed_at IS NULL',now,i.id)])
  i.eligible_at=now
 }else if(['failed','undelivered','canceled'].includes(String(receipt.status))){
  await change(env,c,'survey.suppress',[sql(env,'UPDATE hnd_survey_invitations SET suppressed_at=COALESCE(suppressed_at,?),suppression_reason=? WHERE id=? AND eligible_at IS NULL',Date.now(),String(receipt.status),i.id)])
  i.suppressed_at=Date.now()
 }
}
export async function response(env:Bindings,c:Context,rating:number,comment:string,event:string){
 const i=c.invitation
 if(!i.eligible_at||i.suppressed_at||i.expires_at<=Date.now())throw new Fault('survey_not_eligible',409)
 await change(env,c,'survey.respond',[
  guard(env,"SELECT count(*) FROM hnd_text_permissions WHERE id=? AND purpose='survey' AND state IN ('granted','consumed')",i.permission_id),
  sql(env,`INSERT INTO hnd_survey_responses(invitation_id,rating,comment,provider_event,created_at)
   SELECT id,?,?,?,? FROM hnd_survey_invitations WHERE id=? AND eligible_at IS NOT NULL AND suppressed_at IS NULL AND expires_at>?
   ON CONFLICT(invitation_id) DO NOTHING`,rating,comment,event,Date.now(),i.id,Date.now()),
 ])
}
export async function tickSurveys(env:Bindings){
 const pending=(await sql(env,"SELECT id FROM hnd_survey_invitations WHERE channel='sms' AND text_id IS NOT NULL AND eligible_at IS NULL AND suppressed_at IS NULL AND expires_at>? LIMIT 50",Date.now()).all<{id:string}>()).results
 for(const row of pending){try{await syncDelivery(env,await context(env,row.id))}catch(error){if(!(error instanceof Fault))throw error}}
}
