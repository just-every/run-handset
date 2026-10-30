import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { consolePage, escape as e, Fault, json, keys, type ObjectValue } from '../core'
import { guard, nativeFence, sql } from '../delegation/store'
import { deliveryContent, type DeliveryJob, type DeliverySetting } from './delivery'
import { mailboxDeliveryAccess } from './doors'
interface Link {id:string;job_id:string;expires_at:number;revoked_at:number|null}
export async function voicemailLinkDoor(request:Request,env:Bindings,a:Session,v?:ObjectValue):Promise<Response>{
 const path=new URL(request.url).pathname,match=path.match(/^\/(?:api\/handset|app)\/voicemail\/links\/([0-9a-f-]{36})(?:\/(audio|revoke))?$/)
 if(!match||new URL(request.url).search)throw new Fault('not_found',404)
 const link=await sql(env,'SELECT * FROM hnd_vm_links WHERE id=?',match[1]).first<Link>()
 if(!link)throw new Fault('voicemail_link_unavailable',403)
 const job=await sql(env,'SELECT * FROM hnd_vm_jobs WHERE id=?',link.job_id).first<DeliveryJob>()
 if(!job)throw new Fault('voicemail_link_unavailable',403)
 if(request.method==='POST'&&match[2]==='revoke'){
  keys(v!,[])
  const s=await sql(env,'SELECT * FROM hnd_vm_settings WHERE id=?',job.setting_id).first<DeliverySetting>()
  if(!s)throw new Fault('voicemail_link_unavailable',403)
  const access=await mailboxDeliveryAccess(env,a.operator.id,a.operator.version,s.box_id,true)
  await commit(env,a,'voicemail.revoke',link.id,'completed',[nativeFence(env,a),...access.fences(),sql(env,'UPDATE hnd_vm_links SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',Date.now(),link.id)],false)
  return json({revoked:true})
 }
 if(request.method!=='GET'||match[2]==='revoke')throw new Fault('method_not_allowed',405)
 if(link.revoked_at||link.expires_at<=Date.now()||!['sending','accepted','development','uncertain'].includes(job.state))throw new Fault('voicemail_link_unavailable',403)
 const data=await deliveryContent(env,job)
 if(data.setting.mode!=='link'||data.setting.person_id!==a.operator.id||data.setting.person_version!==a.operator.version)throw new Fault('exact_voicemail_recipient_required',403)
 const fences=()=>[nativeFence(env,a),...data.fences(),guard(env,'SELECT count(*) FROM hnd_vm_links WHERE id=? AND revoked_at IS NULL AND expires_at>?',link.id,Date.now())]
 const bytes=match[2]==='audio'?await data.media!.bytes(fences):null
 await commit(env,a,'voicemail.link',link.id,'completed',fences(),false)
 if(bytes)return new Response(bytes,{headers:{'content-type':'audio/wav','cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-disposition':'inline; filename="voicemail.wav"','content-security-policy':"default-src 'none'; sandbox"}})
 if(path.startsWith('/api/'))return json({itemId:data.item.id,recordingId:data.content.recording_id,sourceId:data.content.source_id,provenance:data.transcript.provenance,text:data.transcript.content,expiresAt:link.expires_at})
 const response=await consolePage('Authenticated voicemail',`<p role="status">Access expires ${e(new Date(link.expires_at).toISOString())}. Recipient, mailbox, source and independent content grants are checked on every read.</p><p>${e(data.transcript.provenance)}</p><pre>${e(data.transcript.content)}</pre><audio controls preload="none" aria-label="Approved voicemail" src="/api/handset/voicemail/links/${e(link.id)}/audio"></audio><p>Received bytes cannot be recalled.</p><a href="/app/voicemail">Return to voicemail</a>`)
 response.headers.set('content-security-policy',response.headers.get('content-security-policy')+"; media-src 'self'")
 return response
}
