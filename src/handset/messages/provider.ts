import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { boundedBody, digest, Fault, id, text } from '../core'
import { guard, policyAuthority, readTwilio, type ConsentPolicy } from '../consent/store'
import { job, thread, permission, permissionFence, custodyFence, sourceFence } from './store'
import { requireNoStop, noStopFence } from './suppression'
import type { Media, MessageJob } from './model'

async function authority(env:Bindings,j:MessageJob) {
 const {row:t,source}=await thread(env,j.thread_id)
 if(t.custody!=='handset'||t.owner_id!==j.created_by||t.revision!==j.thread_revision)throw new Fault('thread_custody_changed',409)
 const owner=await env.DB.prepare("SELECT id FROM oa_operators WHERE id=? AND version=? AND status='active' AND role='owner'").bind(j.created_by,j.owner_version).first()
 if(!owner)throw new Fault('message_approver_inactive',403)
 await permission(env,j.permission_id,t.peer);await requireNoStop(env,[t.peer])
 const p=await env.DB.prepare('SELECT * FROM hnd_consent_policies WHERE id=? AND source_id=?').bind(j.policy_id,t.source_id).first<ConsentPolicy>()
 if(!p)throw new Fault('reviewed_consent_policy_required',409)
 const policy=await policyAuthority(env,p)
 const hours=await env.DB.prepare(`SELECT r.* FROM hnd_text_recipients r JOIN oa_operators o ON o.id=r.approved_by WHERE r.recipient=? AND r.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=r.owner_version`).bind(t.peer,Date.now()).first<{timezone:string;start_minute:number;end_minute:number}>()
 if(!hours)throw new Fault('recipient_timezone_unknown_or_expired',409)
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:hours.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date())
 const minute=Number(parts.find(p=>p.type==='hour')?.value)*60+Number(parts.find(p=>p.type==='minute')?.value)
 if(minute<hours.start_minute||minute>=hours.end_minute)throw new Fault('recipient_quiet_hours',409)
 return {t,source,p,fences:[...policy.fences,custodyFence(env,t,j.created_by),permissionFence(env,j.permission_id,t.peer),noStopFence(env,t.peer),guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active' AND role='owner'",j.created_by,j.owner_version),guard(env,`SELECT count(*) FROM hnd_text_recipients r JOIN oa_operators o ON o.id=r.approved_by WHERE r.recipient=? AND r.timezone=? AND r.start_minute=? AND r.end_minute=? AND r.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=r.owner_version`,t.peer,hours.timezone,hours.start_minute,hours.end_minute,Date.now())]}
}
export async function dispatchMessage(env:Bindings,key:string) {
 const j=await job(env,key)
 if(j.state!=='queued'||j.due_at>Date.now())return j
 let claimed=false
 try {
  const first=await authority(env,j)
  const registration=await readTwilio(env,first.source,`https://messaging.twilio.com/v1/Tollfree/Verifications/${encodeURIComponent(first.p.registration_id)}`)
  if(registration.sid!==first.p.registration_id||registration.account_sid!==first.source.account_id||registration.tollfree_phone_number!==first.t.business||registration.status!=='TWILIO_APPROVED')throw new Fault('tollfree_registration_not_approved',409)
  for(const media of JSON.parse(j.media) as Media[]) {
   const metadata=await readTwilio(env,first.source,media.url+'.json')
   const parts=new URL(media.url).pathname.split('/')
   if(metadata.account_sid!==first.source.account_id||metadata.content_type!==media.mime||metadata.parent_sid!==parts[5]||metadata.sid!==parts[7]||metadata.uri!==new URL(media.url).pathname+'.json')throw new Fault('provider_media_metadata_mismatch',409)
   const response=await fetch(media.url,{headers:{authorization:'Basic '+btoa(first.source.account_id+':'+env.HANDSET_TWILIO_AUTH_TOKEN)},redirect:'manual',signal:AbortSignal.timeout(5000)})
   if(response.status!==200||response.headers.get('content-type')?.split(';')[0].trim()!==media.mime) {
    await response.body?.cancel()
    throw new Fault('provider_media_unavailable',409)
   }
   // Approval bounds the read; only the measured body can confirm its size.
   const bytes=await boundedBody(response,media.bytes,'provider_media_size_mismatch',409)
   if(bytes.byteLength!==media.bytes)throw new Fault('provider_media_size_mismatch',409)
  }
  // Recheck all mutable authority after every provider preflight and claim once.
  const fresh=await authority(env,j)
  await append(env,j.created_by,'message.send',j.id,'uncertain',[...fresh.fences,guard(env,"SELECT count(*) FROM hnd_message_jobs WHERE id=? AND state='queued' AND revision=?",j.id,j.revision),env.DB.prepare("UPDATE hnd_message_jobs SET state='sending',provider_state='unconfirmed',reason='Submission claimed once; provider result unconfirmed',submitted_at=?,revision=revision+1 WHERE id=?").bind(Date.now(),key)],null,sourcePolicy(fresh.source))
  claimed=true
  await requireNoStop(env,[fresh.t.peer])
  const form=new URLSearchParams({From:fresh.t.business,To:fresh.t.peer,Body:j.body,StatusCallback:env.AUTH_ORIGIN+'/providers/twilio/consent/messages/'+key+'/status'})
  for(const media of JSON.parse(j.media) as Media[])form.append('MediaUrl',media.url)
  const response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(fresh.source.account_id)}/Messages.json`,{method:'POST',headers:{authorization:'Basic '+btoa(fresh.source.account_id+':'+env.HANDSET_TWILIO_AUTH_TOKEN),'content-type':'application/x-www-form-urlencoded'},body:form,redirect:'manual',signal:AbortSignal.timeout(5000)})
  if(response.status!==201)throw new Fault('message_create_uncertain',409)
  const receipt=await response.json() as {sid?:unknown}
  if(typeof receipt.sid!=='string'||!receipt.sid||receipt.sid.length>200)throw new Fault('message_create_uncertain',409)
  await env.DB.prepare("UPDATE hnd_message_jobs SET provider_sid=? WHERE id=? AND state='sending'").bind(receipt.sid,key).run()
  return await refreshMessage(env,key)
 } catch(error) {
  const current=await job(env,key)
  if(!['queued','sending'].includes(current.state)||!claimed&&current.state!=='queued')return current
  const reason=error instanceof Fault?error.code:'message_transport_uncertain'
  const stopped=reason==='recipient_STOP_or_DNC',state=claimed&&!stopped?'uncertain':'suppressed'
  await append(env,j.created_by,'message.send',key,state==='suppressed'?'refused':'uncertain',[env.DB.prepare('UPDATE hnd_message_jobs SET state=?,provider_state=?,reason=?,revision=revision+1 WHERE id=? AND state=? AND revision=?').bind(state,state==='uncertain'?'unknown':'not submitted',reason,key,current.state,claimed?current.revision:j.revision)])
  return job(env,key)
 }
}
export async function refreshMessage(env:Bindings,key:string,repair?:{sid:string;fences:D1PreparedStatement[];authorityFences?:D1PreparedStatement[];actor?:string}) {
 const j=await job(env,key),{row:t,source}=await thread(env,j.thread_id)
 const sid=repair?.sid??j.provider_sid
 if(!sid||!['sending','uncertain','accepted','delivered','failed'].includes(j.state))throw new Fault('message_has_no_provider_identity',409)
 if(j.provider_sid&&j.provider_sid!==sid)throw new Fault('message_identity_mismatch',409)
 if(!j.provider_sid&&!j.submitted_at)throw new Fault('message_submission_time_unknown',409)
 const other=await env.DB.prepare('SELECT id FROM hnd_message_jobs WHERE provider_sid=? AND id<>?').bind(sid,j.id).first()
 if(other)throw new Fault('message_identity_already_linked',409)
 let r:Record<string,unknown>
 try { r=await readTwilio(env,source,`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(source.account_id)}/Messages/${encodeURIComponent(sid)}.json`) }
 catch(error) {
  if(error instanceof Fault)await append(env,repair?.actor??source.id,'message.receipt',key,'refused',[
   sourceFence(env,source),...(repair?.authorityFences??[]),guard(env,'SELECT count(*) FROM hnd_message_jobs WHERE id=? AND revision=?',j.id,j.revision),
   env.DB.prepare('UPDATE hnd_message_jobs SET reason=?,revision=revision+1 WHERE id=?').bind(error.code+'; prior submission remains unconfirmed',key),
  ],null,sourcePolicy(source))
  throw error
 }
 if(r.sid!==sid||r.account_sid!==source.account_id||r.from!==t.business||r.to!==t.peer||r.body!==j.body||r.direction!=='outbound-api'||Number(r.num_media??0)!==(JSON.parse(j.media) as Media[]).length)throw new Fault('message_readback_identity_mismatch',502)
 const occurredAt=Date.parse(String(r.date_created))
 if(!Number.isFinite(occurredAt)||occurredAt>Date.now()+1000)throw new Fault('provider_time_unavailable',503)
 // Twilio timestamps have whole-second precision. Older receipts cannot settle
 // a newly submitted message with coincidentally identical content.
 if(!j.provider_sid&&occurredAt<Math.floor(j.submitted_at!/1000)*1000)throw new Fault('message_readback_predates_submission',409)
 const statuses=['accepted','queued','sending','sent','delivered','undelivered','failed']
 if(!statuses.includes(String(r.status)))throw new Fault('message_readback_unconfirmed',409)
 const oldRank=statuses.indexOf(j.provider_state),newRank=statuses.indexOf(String(r.status))
 if(['delivered','failed','undelivered'].includes(j.provider_state)&&r.status!==j.provider_state||newRank<oldRank) {
  if(repair)await append(env,repair.actor??source.id,'message.receipt',key,'completed',[sourceFence(env,source),...repair.fences,guard(env,'SELECT count(*) FROM hnd_message_jobs WHERE id=? AND revision=?',j.id,j.revision)],null,sourcePolicy(source))
  return j
 }
 const carrier=r.status==='delivered'?'delivered':['failed','undelivered'].includes(String(r.status))?'failed':'unconfirmed',state=carrier==='delivered'?'delivered':carrier==='failed'?'failed':'accepted'
 await append(env,repair?.actor??source.id,'message.receipt',key,'completed',[sourceFence(env,source),...(repair?.fences??[]),guard(env,'SELECT count(*) FROM hnd_message_jobs WHERE id=? AND revision=?',j.id,j.revision),env.DB.prepare('UPDATE hnd_message_jobs SET state=?,provider_state=?,carrier_state=?,reason=?,provider_sid=?,readback_at=?,revision=revision+1 WHERE id=?').bind(state,String(r.status),carrier,'Independent provider readback; no read receipt',sid,Date.now(),key),env.DB.prepare(`INSERT INTO hnd_inbox_messages VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,provider_sid) DO UPDATE SET provider_state=excluded.provider_state,carrier_state=excluded.carrier_state`).bind(id(),t.id,sid,'outbound',j.body,j.media,JSON.stringify([t.business,t.peer]),String(r.status),carrier,occurredAt)],null,sourcePolicy(source))
 return job(env,key)
}
export async function observeMessageStatus(env:Bindings,p:URLSearchParams) {
 const sid=p.get('MessageSid');if(!sid)return
 const j=await env.DB.prepare('SELECT id FROM hnd_message_jobs WHERE provider_sid=?').bind(sid).first<{id:string}>()
 if(j)await refreshMessage(env,j.id)
}
/** Signature verification is performed by the carrier transport before this door. */
export async function messageReceipt(env:Bindings,key:string,p:URLSearchParams) {
 const j=await job(env,key),{row:t,source}=await thread(env,j.thread_id)
 const sid=text(p.get('MessageSid'),'MessageSid'),status=text(p.get('MessageStatus')??p.get('SmsStatus'),'MessageStatus')
 if(p.get('AccountSid')!==source.account_id||p.get('From')!==t.business||p.get('To')!==t.peer)throw new Fault('message_callback_identity_mismatch',403)
 const hash=await digest([...p].sort(([a],[b])=>a.localeCompare(b)))
 const previous=await env.DB.prepare('SELECT body_hash FROM hnd_message_delivery_receipts WHERE job_id=? AND provider_sid=? AND status=?').bind(key,sid,status).first<{body_hash:string}>()
 if(previous&&previous.body_hash!==hash)throw new Fault('message_callback_conflict',409)
 return refreshMessage(env,key,{sid,fences:[
  guard(env,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_message_delivery_receipts WHERE job_id=? AND provider_sid=? AND status=? AND body_hash<>?) THEN 0 ELSE 1 END',key,sid,status,hash),
  env.DB.prepare('INSERT INTO hnd_message_delivery_receipts VALUES (?,?,?,?,?) ON CONFLICT(job_id,provider_sid,status) DO NOTHING').bind(key,sid,status,hash,Date.now()),
 ]})
}
export async function tickMessages(env:Bindings) {
 // A process may die after the durable claim, before saving the response.
 // Never put that message back in the send queue.
 await env.DB.prepare("UPDATE hnd_message_jobs SET state='uncertain',reason='Submission interrupted; provider readback required',revision=revision+1 WHERE state='sending' AND (submitted_at IS NULL OR submitted_at<?)").bind(Date.now()-60000).run()
 const due=(await env.DB.prepare("SELECT id FROM hnd_message_jobs WHERE state='queued' AND due_at<=? ORDER BY due_at,id LIMIT 100").bind(Date.now()).all<{id:string}>()).results
 for(const j of due)await dispatchMessage(env,j.id)
}
