import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { operatorMail } from '../../mail.server.mjs'
import { actorRef, append, commit } from '../audit/store'
import { choice, escape, Fault, id, integer, json, keys, text, type ObjectValue } from '../core'
import { nativeFence, guard, sql } from '../delegation/store'
import { recordingDeliveryAccess } from '../recording/doors'
import { transcriptDeliveryAccess } from '../transcripts/doors'
import { mailboxDeliveryAccess, type Item } from './doors'

export interface DeliverySetting {id:string;box_id:string;person_id:string;person_version:number;recipient:string;owner_id:string;owner_version:number;box_revision:number;policy_revision:number;revision:number;mode:'attachment_text'|'text'|'link';enabled:number;link_seconds:number}
export interface DeliveryJob {id:string;item_id:string;setting_id:string;setting_revision:number;due_at:number;created_at:number;state:string;reason:string|null;link_id:string}
interface Content {item_id:string;recording_id:string;transcript_id:string;source_id:string;source_revision:number}
export const copyConsent='I approve this exact recipient and mode with separate email custody'
export const copyNotice='Email recipients may retain and forward copies. Later revocation or local erasure cannot recall an attachment or text already delivered. Provider acceptance does not establish inbox delivery.'
const base='/api/handset/voicemail'
const policy=async(env:Bindings,boxId:string)=>await sql(env,'SELECT revision,link_only FROM hnd_vm_policy WHERE box_id=?',boxId).first<{revision:number;link_only:number}>()??{revision:0,link_only:0}
const policyFence=(env:Bindings,boxId:string,revision:number)=>guard(env,'SELECT CASE WHEN COALESCE((SELECT revision FROM hnd_vm_policy WHERE box_id=?),0)=? THEN 1 ELSE 0 END',boxId,revision)
const settingFence=(env:Bindings,s:DeliverySetting)=>guard(env,`SELECT count(*) FROM hnd_vm_settings s JOIN oa_operators p ON p.id=s.person_id WHERE s.id=? AND s.revision=? AND s.enabled=1 AND p.status='active' AND p.version=s.person_version AND p.email=s.recipient`,s.id,s.revision)
export async function deliveryView(env:Bindings,a:Session,boxId:string){
 const access=await mailboxDeliveryAccess(env,a.operator.id,a.operator.version,boxId,true)
 const settings=(await sql(env,'SELECT * FROM hnd_vm_settings WHERE box_id=? ORDER BY recipient',boxId).all<DeliverySetting>()).results
 const jobs=(await sql(env,'SELECT j.*,l.expires_at,l.revoked_at FROM hnd_vm_jobs j JOIN hnd_vm_settings s ON s.id=j.setting_id LEFT JOIN hnd_vm_links l ON l.job_id=j.id WHERE s.box_id=? ORDER BY j.created_at DESC LIMIT 100',boxId).all<DeliveryJob&{expires_at:number|null;revoked_at:number|null}>()).results
 const currentPolicy=await policy(env,boxId)
 await env.DB.batch([nativeFence(env,a),...access.fences(),sql(env,'DELETE FROM hnd_guard')])
 const recipients=[]
 const candidates=(await sql(env,"SELECT id,display_name,email,version FROM oa_operators WHERE status='active'").all<{id:string;display_name:string;email:string;version:number}>()).results
 for(const person of candidates){try{await mailboxDeliveryAccess(env,person.id,person.version,boxId);recipients.push(person)}catch(error){if(!(error instanceof Fault))throw error}}
 await env.DB.batch([nativeFence(env,a),...access.fences(),sql(env,'DELETE FROM hnd_guard')])
 return {settings,jobs,recipients,policy:currentPolicy,notice:copyNotice}
}
/** Resolve current native identities, exact settings, source and independent grants. */
export async function deliveryContent(env:Bindings,job:DeliveryJob){
 const s=await sql(env,'SELECT * FROM hnd_vm_settings WHERE id=? AND revision=? AND enabled=1',job.setting_id,job.setting_revision).first<DeliverySetting>()
 if(!s)throw new Fault('delivery_settings_changed',403)
 const sender=await mailboxDeliveryAccess(env,s.owner_id,s.owner_version,s.box_id,true),recipient=await mailboxDeliveryAccess(env,s.person_id,s.person_version,s.box_id)
 if(sender.box.revision!==s.box_revision)throw new Fault('mailbox_membership_changed',403)
 const p=await policy(env,s.box_id)
 if(p.revision!==s.policy_revision||p.link_only&&s.mode!=='link')throw new Fault('link_only_policy_required',403)
 const item=await sql(env,'SELECT * FROM hnd_voicemail_items WHERE id=? AND box_id=?',job.item_id,s.box_id).first<Item>()
 const content=await sql(env,'SELECT * FROM hnd_vm_content WHERE item_id=?',job.item_id).first<Content>()
 if(!item||!content||item.source_id!==content.recording_id)throw new Fault('voicemail_content_unavailable',409)
 const reader=await transcriptDeliveryAccess(env,s.person_id,s.person_version,content.transcript_id)
 const author=await transcriptDeliveryAccess(env,s.owner_id,s.owner_version,content.transcript_id)
 if(reader.recordingId!==content.recording_id||reader.sourceId!==content.source_id||reader.sourceRevision!==content.source_revision)throw new Fault('voicemail_source_changed',403)
 const media=s.mode==='text'?null:await recordingDeliveryAccess(env,s.person_id,s.person_version,content.recording_id)
 const ownerMedia=s.mode==='text'?null:await recordingDeliveryAccess(env,s.owner_id,s.owner_version,content.recording_id)
 if(media&&(media.sourceId!==content.source_id||media.sourceRevision!==content.source_revision))throw new Fault('voicemail_source_changed',403)
 const fences=()=>[...sender.fences(),...recipient.fences(),settingFence(env,s),policyFence(env,s.box_id,p.revision),...reader.fences(),...author.fences(),...(media?.fences()??[]),...(ownerMedia?.fences()??[]),guard(env,'SELECT count(*) FROM hnd_vm_content c JOIN hnd_voicemail_items i ON i.id=c.item_id WHERE c.item_id=? AND c.recording_id=? AND c.transcript_id=? AND i.source_id=c.recording_id',item.id,content.recording_id,content.transcript_id)]
 await env.DB.batch([...fences(),sql(env,'DELETE FROM hnd_guard')])
 return {setting:s,item,content,transcript:reader,media,fences}
}
export async function tickVoicemail(env:Bindings,now=Date.now()){
 const jobs=(await sql(env,"SELECT * FROM hnd_vm_jobs WHERE state='queued' AND due_at<=? ORDER BY due_at,id LIMIT 20",now).all<DeliveryJob>()).results
 for(const job of jobs){
  // Persist a single winner before retrieving content. A crashed preparation is
  // held, and an uncertain provider acknowledgement is never blindly retried.
  const claim=await sql(env,"UPDATE hnd_vm_jobs SET state='preparing' WHERE id=? AND state='queued'",job.id).run()
  if(claim.meta.changes!==1)continue
  let released=false,actor:string|undefined
  try{
   const data=await deliveryContent(env,job),s=data.setting
   actor=await actorRef(env.DB,s.owner_id)
   const bytes=s.mode==='attachment_text'?await data.media!.bytes(data.fences):undefined
   const sender=operatorMail(env)
   if(!sender||!env.MAIL_FROM)throw new Fault('mail_transport_unavailable',409)
   const expires=Date.now()+s.link_seconds*1000
   // This is the final transaction before the provider edge, after media fetch.
   await append(env,actor,'voicemail.deliver',job.id,'uncertain',[
    ...data.fences(),guard(env,"SELECT count(*) FROM hnd_vm_jobs WHERE id=? AND state='preparing'",job.id),
    ...(s.mode==='link'?[sql(env,'INSERT INTO hnd_vm_links VALUES (?,?,?,NULL)',job.link_id,job.id,expires)]:[]),
    sql(env,"UPDATE hnd_vm_jobs SET state='sending' WHERE id=? AND state='preparing'",job.id),
   ])
   released=true
   const body=s.mode==='link'?`Authenticated voicemail link: ${env.AUTH_ORIGIN}/app/voicemail/links/${job.link_id}\nExpires: ${new Date(expires).toISOString()}. Sign in as the exact recipient. Access and revocation are checked on every read.`:`${data.transcript.provenance}\n${data.transcript.content}`
   const messageText=`${body}\n\nItem: ${data.item.id}\nRecording: ${data.content.recording_id}\nSource: ${data.content.source_id} revision ${data.content.source_revision}\n\n${copyNotice}`
   const result=await sender.send({deliveryId:job.id,from:env.MAIL_FROM,to:[s.recipient],subject:'Handset voicemail',text:messageText,html:`<pre>${escape(messageText)}</pre>`,headers:{},...(bytes?{attachments:[{filename:'voicemail.wav',contentType:'audio/wav',content:bytes}]}:{})})
   const state=['accepted','development','uncertain'].includes(result.status)?result.status:'failed'
   await append(env,actor,'voicemail.deliver',job.id,state==='accepted'||state==='development'?'completed':state==='uncertain'?'uncertain':'failed',[sql(env,"UPDATE hnd_vm_jobs SET state=? WHERE id=? AND state='sending'",state,job.id)])
  }catch(error){
   const state=released?'uncertain':'suppressed',reason=error instanceof Fault?error.code:'delivery_unavailable'
   await sql(env,"UPDATE hnd_vm_jobs SET state=?,reason=? WHERE id=? AND state IN ('preparing','sending')",state,reason,job.id).run()
  }
 }
}
export async function voicemailDeliveryDoor(request:Request,env:Bindings,a:Session,v?:ObjectValue):Promise<Response|null>{
 const path=new URL(request.url).pathname
 if(path.startsWith(base+'/links/'))return (await import('./links')).voicemailLinkDoor(request,env,a,v)
 const match=path.match(/^\/api\/handset\/voicemail\/boxes\/([^/]+)\/(delivery|delivery-policy|items\/([^/]+)\/(content|deliver))$/)
 if(!match)return null
 const boxId=match[1],operation=match[4]??match[2]
 const access=await mailboxDeliveryAccess(env,a.operator.id,a.operator.version,boxId,true),box=access.box
 if(request.method==='GET'&&operation==='delivery')return json(await deliveryView(env,a,boxId))
 if(request.method!=='POST'||!v)throw new Fault('method_not_allowed',405)
 const guards=[nativeFence(env,a),...access.fences()]
 if(operation==='delivery-policy'){
  keys(v,['revision','linkOnly','confirm'])
  if(v.confirm!=='approve exact mailbox delivery policy')throw new Fault('delivery_policy_consent_required',403)
  const p=await policy(env,boxId),revision=integer(v.revision,'revision',0),linkOnly=integer(v.linkOnly,'linkOnly',0,1)
  if(revision!==p.revision)throw new Fault('delivery_policy_changed',409)
  await commit(env,a,'voicemail.configure',boxId,'completed',[...guards,policyFence(env,boxId,revision),sql(env,'INSERT INTO hnd_vm_policy VALUES (?,?,?) ON CONFLICT(box_id) DO UPDATE SET revision=excluded.revision,link_only=excluded.link_only',boxId,revision+1,linkOnly)],false)
  return json({revision:revision+1,linkOnly})
 }
 if(operation==='delivery'){
  keys(v,['personId','recipient','personVersion','revision','mode','enabled','linkSeconds','confirm'])
  if(v.confirm!==copyConsent)throw new Fault('external_copy_consent_required',403)
  const personId=text(v.personId,'personId'),person=await sql(env,"SELECT version,email FROM oa_operators WHERE id=? AND status='active'",personId).first<{version:number;email:string}>()
  if(!person)throw new Fault('current_mailbox_person_required',403)
  if(v.recipient!==person.email||v.personVersion!==person.version)throw new Fault('reviewed_recipient_changed',409)
  const recipient=await mailboxDeliveryAccess(env,personId,person.version,boxId),p=await policy(env,boxId)
  const mode=choice(v.mode,['attachment_text','text','link'],'mode'),enabled=integer(v.enabled,'enabled',0,1),seconds=integer(v.linkSeconds,'linkSeconds',60,3600)
  if(p.link_only&&mode!=='link')throw new Fault('link_only_policy_required',403)
  const old=await sql(env,'SELECT * FROM hnd_vm_settings WHERE box_id=? AND person_id=?',boxId,personId).first<DeliverySetting>(),revision=integer(v.revision,'revision',0)
  if(revision!==(old?.revision??0))throw new Fault('delivery_settings_changed',409)
  const target=old?.id??id()
  await commit(env,a,'voicemail.configure',boxId,'completed',[...guards,...recipient.fences(),policyFence(env,boxId,p.revision),guard(env,'SELECT CASE WHEN COALESCE((SELECT revision FROM hnd_vm_settings WHERE box_id=? AND person_id=?),0)=? THEN 1 ELSE 0 END',boxId,personId,revision),sql(env,'INSERT INTO hnd_vm_settings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(box_id,person_id) DO UPDATE SET person_version=excluded.person_version,recipient=excluded.recipient,owner_id=excluded.owner_id,owner_version=excluded.owner_version,box_revision=excluded.box_revision,policy_revision=excluded.policy_revision,revision=excluded.revision,mode=excluded.mode,enabled=excluded.enabled,link_seconds=excluded.link_seconds',target,boxId,personId,person.version,person.email,a.operator.id,a.operator.version,box.revision,p.revision,revision+1,mode,enabled,seconds)],false)
  return json({id:target,revision:revision+1,recipient:person.email,mode,enabled},201)
 }
 const item=await sql(env,'SELECT * FROM hnd_voicemail_items WHERE id=? AND box_id=?',match[3],boxId).first<Item>()
 if(!item)throw new Fault('not_found',404)
 if(operation==='content'){
  keys(v,['recordingId','transcriptId'])
  const recordingId=text(v.recordingId,'recordingId'),transcriptId=text(v.transcriptId,'transcriptId')
  if(item.source_id!==recordingId)throw new Fault('exact_native_recording_source_required',409)
  const media=await recordingDeliveryAccess(env,a.operator.id,a.operator.version,recordingId),words=await transcriptDeliveryAccess(env,a.operator.id,a.operator.version,transcriptId)
  if(words.recordingId!==recordingId||words.sourceId!==media.sourceId||words.sourceRevision!==media.sourceRevision)throw new Fault('matching_voicemail_content_required',409)
  const old=await sql(env,'SELECT * FROM hnd_vm_content WHERE item_id=?',item.id).first<Content>()
  if(old&&(old.recording_id!==recordingId||old.transcript_id!==transcriptId))throw new Fault('content_binding_immutable',409)
  await commit(env,a,'voicemail.bind',item.id,'completed',[...guards,...media.fences(),...words.fences(),sql(env,'INSERT INTO hnd_vm_content VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',item.id,recordingId,transcriptId,media.sourceId,media.sourceRevision)],false)
  return json({bound:true},201)
 }
 keys(v,['settingId','dueAt','confirm'])
 if(v.confirm!=='queue this exact voicemail delivery')throw new Fault('delivery_consent_required',403)
 const job:DeliveryJob={id:id(),item_id:item.id,setting_id:text(v.settingId,'settingId'),setting_revision:0,due_at:integer(v.dueAt,'dueAt',Date.now()-60000,Date.now()+31*86400000),created_at:Date.now(),state:'queued',reason:null,link_id:id()}
 const s=await sql(env,'SELECT * FROM hnd_vm_settings WHERE id=? AND box_id=?',job.setting_id,boxId).first<DeliverySetting>()
 if(!s)throw new Fault('delivery_settings_required',409)
 job.setting_revision=s.revision
 const data=await deliveryContent(env,job)
 const old=await sql(env,'SELECT * FROM hnd_vm_jobs WHERE item_id=? AND setting_id=? AND setting_revision=?',item.id,s.id,s.revision).first<DeliveryJob>()
 if(old)return json({job:old,replay:true})
 await commit(env,a,'voicemail.enqueue',job.id,'completed',[...guards,...data.fences(),sql(env,'INSERT INTO hnd_vm_jobs VALUES (?,?,?,?,?,?,?,?,?)',...Object.values(job))],false)
 return json({job,replay:false},201)
}
