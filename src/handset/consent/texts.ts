import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { Fault, id, text } from '../core'
import { getCall, getPolicy, guard, policyAuthority, readTwilio, type Permission } from './store'

export interface CareText {id:string;permission_id:string;state:string;provider_sid:string|null;reason:string;created_at:number;accepted_at:number|null;delivered_at:number|null;body:string;deadline_at:number|null}
export async function getText(env:Bindings,key:string) {
 const row=await env.DB.prepare('SELECT * FROM hnd_care_texts WHERE id=?').bind(key).first<CareText>()
 if(!row)throw new Fault('text_not_found',404)
 return row
}
export async function enqueueText(env:Bindings,permissionId:string,body:string,deadlineAt:number|null):Promise<CareText> {
 const old=await env.DB.prepare('SELECT * FROM hnd_care_texts WHERE permission_id=?').bind(permissionId).first<CareText>()
 if(old)return old
 const permission=await env.DB.prepare('SELECT * FROM hnd_text_permissions WHERE id=?').bind(permissionId).first<Permission>()
 if(!permission||permission.state!=='granted')throw new Fault('explicit_purpose_permission_required',409)
 const call=await getCall(env,permission.call_id),policy=await getPolicy(env,call.policy_id),{source,fences}=await policyAuthority(env,policy)
 const row:CareText={id:id(),permission_id:permissionId,body:text(body,'body',1000),state:'pending',provider_sid:null,reason:'Awaiting current delivery gates',created_at:Date.now(),accepted_at:null,delivered_at:null,deadline_at:deadlineAt}
 await append(env,source.id,'consent.enqueue',row.id,'completed',[...fences,guard(env,"SELECT count(*) FROM hnd_text_permissions WHERE id=? AND state='granted'",permissionId),env.DB.prepare('INSERT INTO hnd_care_texts(id,permission_id,body,state,provider_sid,reason,created_at,accepted_at,delivered_at,deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(...Object.values(row))],null,sourcePolicy(source))
 return row
}
const stopQuery="SELECT count(*) FROM hnd_protection_stops WHERE recipient=? AND channel IN ('sms','all')"
export async function dispatchText(env:Bindings,key:string):Promise<CareText> {
 const row=await getText(env,key)
 if(row.state!=='pending')return row
 const permission=(await env.DB.prepare('SELECT * FROM hnd_text_permissions WHERE id=?').bind(row.permission_id).first<Permission>())!
 const call=await getCall(env,permission.call_id),policy=await getPolicy(env,call.policy_id)
 let claimed=false
 let source:Awaited<ReturnType<typeof policyAuthority>>['source']|undefined
 try {
  const authority=await policyAuthority(env,policy);source=authority.source
  const now=Date.now()
  if(row.deadline_at!==null&&now>row.deadline_at)throw new Fault('one_reply_deadline_expired',409)
  if(call.identity!=='provider_validated_number')throw new Fault('caller_identity_unclear',409)
  if(permission.state!=='granted')throw new Fault('permission_unavailable',409)
  if(Number(await env.DB.prepare(stopQuery).bind(call.caller).first<number>('count(*)'))>0)throw new Fault('recipient_STOP_or_DNC',409)
  const recipient=await env.DB.prepare(`SELECT r.* FROM hnd_text_recipients r JOIN oa_operators o ON o.id=r.approved_by WHERE recipient=? AND expires_at>? AND o.status='active' AND o.role='owner' AND o.version=r.owner_version`).bind(call.caller,now).first<{timezone:string;start_minute:number;end_minute:number;expires_at:number;approved_by:string;owner_version:number}>()
  if(!recipient)throw new Fault('recipient_timezone_unknown_or_expired',409)
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:recipient.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now))
  const minute=Number(parts.find(p=>p.type==='hour')?.value)*60+Number(parts.find(p=>p.type==='minute')?.value)
  if(minute<recipient.start_minute||minute>=recipient.end_minute)throw new Fault('recipient_quiet_hours',409)
  const registration=await readTwilio(env,source,`https://messaging.twilio.com/v1/Tollfree/Verifications/${encodeURIComponent(policy.registration_id)}`)
  if(registration.sid!==policy.registration_id||registration.account_sid!==source.account_id||registration.tollfree_phone_number!==call.business||registration.status!=='TWILIO_APPROVED')throw new Fault('tollfree_registration_not_approved',409)
  // Repeat authority after network readback. A claimed or uncertain request is
  // never automatically retried: Twilio message creation has no replay key.
  const fresh=await policyAuthority(env,policy)
  await append(env,source.id,'consent.send',row.id,'uncertain',[...fresh.fences,
   guard(env,"SELECT count(*) FROM hnd_care_texts WHERE id=? AND state='pending'",key),
   guard(env,"SELECT count(*) FROM hnd_text_permissions WHERE id=? AND state='granted'",permission.id),
   guard(env,'SELECT CASE WHEN ('+stopQuery+')=0 THEN 1 ELSE 0 END',call.caller),
   guard(env,`SELECT count(*) FROM hnd_text_recipients r JOIN oa_operators o ON o.id=r.approved_by WHERE r.recipient=? AND r.timezone=? AND r.start_minute=? AND r.end_minute=? AND r.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=r.owner_version`,call.caller,recipient.timezone,recipient.start_minute,recipient.end_minute,Date.now()),
   env.DB.prepare("UPDATE hnd_care_texts SET state='sending',reason='Submitted once; awaiting independent readback' WHERE id=?").bind(key),
   env.DB.prepare("UPDATE hnd_text_permissions SET state='reserved' WHERE id=?").bind(permission.id),
  ],null,sourcePolicy(source))
  claimed=true
  const endpoint=`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(source.account_id)}/Messages.json`
  const response=await fetch(endpoint,{method:'POST',headers:{authorization:'Basic '+btoa(source.account_id+':'+env.HANDSET_TWILIO_AUTH_TOKEN),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({From:call.business,To:call.caller,Body:row.body,StatusCallback:env.AUTH_ORIGIN+`/providers/twilio/consent/texts/${key}/status`}),redirect:'manual',signal:AbortSignal.timeout(5000)})
  if(response.status!==201)throw new Fault('text_acceptance_uncertain',409)
  const accepted=await response.json() as Record<string,unknown>,sid=text(accepted.sid,'messageSid')
  // Persist the returned identity before readback so lost readback can be
  // reconciled by a matching signed callback without a second create request.
  await env.DB.prepare("UPDATE hnd_care_texts SET provider_sid=? WHERE id=? AND state='sending'").bind(sid,key).run()
  await confirmText(env,key,sid)
 } catch(error) {
  const current=await getText(env,key)
  if(!claimed&&current.state!=='pending'||!['pending','sending'].includes(current.state))return current
  const reason=error instanceof Fault?error.code:'text_transport_uncertain',state=current.state==='pending'?'suppressed':'uncertain'
  await append(env,source?.id??policy.approved_by,'consent.send',key,state==='suppressed'?'refused':'uncertain',[
   env.DB.prepare('UPDATE hnd_care_texts SET state=?,reason=? WHERE id=? AND state=?').bind(state,reason,key,current.state),
  ])
 }
 return getText(env,key)
}
export async function confirmText(env:Bindings,key:string,sid:string) {
 const row=await getText(env,key),permission=(await env.DB.prepare('SELECT * FROM hnd_text_permissions WHERE id=?').bind(row.permission_id).first<Permission>())!
 if(row.provider_sid!==sid||!['sending','uncertain','confirmed'].includes(row.state))throw new Fault('message_identity_mismatch',409)
 const call=await getCall(env,permission.call_id),policy=await getPolicy(env,call.policy_id),{source}=await policyAuthority(env,policy)
 const receipt=await readTwilio(env,source,`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(source.account_id)}/Messages/${encodeURIComponent(sid)}.json`)
 if(receipt.sid!==sid||receipt.account_sid!==source.account_id||receipt.from!==call.business||receipt.to!==call.caller||receipt.body!==row.body||receipt.direction!=='outbound-api')throw new Fault('message_readback_mismatch',502)
 if(!['accepted','queued','sending','sent','delivered','undelivered','failed'].includes(String(receipt.status)))throw new Fault('message_readback_unconfirmed',409)
 const delivered=receipt.status==='delivered',now=Date.now()
 await append(env,source.id,'consent.receipt',key,'completed',[
  env.DB.prepare("UPDATE hnd_care_texts SET state='confirmed',reason=?,accepted_at=COALESCE(accepted_at,?),delivered_at=CASE WHEN ? THEN COALESCE(delivered_at,?) ELSE delivered_at END WHERE id=? AND provider_sid=?").bind('Provider '+String(receipt.status)+'; receipt is not a read receipt',now,delivered?1:0,now,key,sid),
  env.DB.prepare("UPDATE hnd_text_permissions SET state='consumed',consumed_at=COALESCE(consumed_at,?) WHERE id=?").bind(now,permission.id),
 ],null,sourcePolicy(source))
 return getText(env,key)
}
export async function tickConsentTexts(env:Bindings) {
 const rows=(await env.DB.prepare("SELECT id FROM hnd_care_texts WHERE state='pending' ORDER BY created_at LIMIT 100").all<{id:string}>()).results
 for(const row of rows)await dispatchText(env,row.id)
}
