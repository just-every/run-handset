import { runtimeBindings, type Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { append, commit } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { boundedBody, Fault, id, json, keys, text, type ObjectValue } from '../core'
import { guard } from '../consent/store'
import { activeSourceById, sourceFence } from '../providers/sources'
import { verifyCarrierSignature } from '../protection/carrier-proof'
import { phone, type Thread } from './model'
interface GroupRoute {id:string;source_id:string;service_sid:string;conversation_sid:string;approved_by:string;owner_version:number;created_at:number;revoked_at:number|null}
const current=(env:Bindings,r:GroupRoute)=>guard(env,"SELECT count(*) FROM hnd_message_group_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.id=? AND r.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=r.owner_version",r.id)
export async function bindGroup(env:Bindings,actor:Session,v:ObjectValue) {
 keys(v,['sourceId','serviceSid','conversationSid','confirm'])
 if(v.confirm!=='authorize exact group metadata only')throw new Fault('explicit_group_source_consent_required',403)
 const source=await activeSourceById(env,text(v.sourceId,'sourceId'))
 if(!source||!/^\+1\d{10}$/.test(source.e164)||/^\+1(?:800|833|844|855|866|877|888)/.test(source.e164))throw new Fault('group_requires_US_or_Canada_long_code',409)
 const key=id(),service=text(v.serviceSid,'serviceSid'),conversation=text(v.conversationSid,'conversationSid')
 try{await commit(env,actor,'message.permission',key,'completed',[sourceFence(env,source),env.DB.prepare('INSERT INTO hnd_message_group_routes VALUES (?,?,?,?,?,?,?,NULL)').bind(key,source.id,service,conversation,actor.operator.id,actor.operator.version,Date.now())])}catch(error){if(String(error).includes('UNIQUE constraint failed: hnd_message_group_routes'))throw new Fault('group_route_already_authorized',409);throw error}
 return {id:key,receiveOnly:true,sendAuthorized:false,providerPath:'/providers/twilio/messages/groups'}
}
async function read(env:Bindings,account:string,path:string) {
 const response=await fetch('https://conversations.twilio.com/v1/'+path,{headers:{authorization:'Basic '+btoa(account+':'+env.HANDSET_TWILIO_AUTH_TOKEN)},redirect:'manual',signal:AbortSignal.timeout(5000)})
 if(response.status!==200)throw new Fault('group_provider_readback_unavailable',503)
 try{return JSON.parse(new TextDecoder().decode(await boundedBody(response,262144))) as Record<string,unknown>}catch(error){if(error instanceof Fault)throw error;throw new Fault('invalid_group_provider_readback',502)}
}
async function receive(env:Bindings,p:URLSearchParams) {
 if(p.get('EventType')!=='onMessageAdded')throw new Fault('unsupported_group_event',409)
 const conversation=text(p.get('ConversationSid'),'ConversationSid'),service=text(p.get('ChatServiceSid'),'ChatServiceSid'),sid=text(p.get('MessageSid'),'MessageSid')
 const r=await env.DB.prepare('SELECT * FROM hnd_message_group_routes WHERE service_sid=? AND conversation_sid=? AND revoked_at IS NULL').bind(service,conversation).first<GroupRoute>()
 if(!r)throw new Fault('group_source_not_authorized',403)
 const source=await activeSourceById(env,r.source_id)
 if(!source)throw new Fault('message_source_inactive',409)
 await env.DB.batch([current(env,r),sourceFence(env,source),env.DB.prepare('DELETE FROM hnd_guard')])
 const base=`Services/${encodeURIComponent(service)}/Conversations/${encodeURIComponent(conversation)}`
 const c=await read(env,source.account_id,base),members=await read(env,source.account_id,base+'/Participants?PageSize=100'),m=await read(env,source.account_id,base+'/Messages/'+encodeURIComponent(sid))
 if(c.account_sid!==source.account_id||c.chat_service_sid!==service||c.sid!==conversation||c.state!=='active'||m.account_sid!==source.account_id||m.conversation_sid!==conversation||m.sid!==sid||m.author!==p.get('Author')||m.body!==(p.get('Body')??''))throw new Fault('group_readback_identity_mismatch',502)
 const pagination=members.meta as {next_page_url?:unknown}|undefined
 if(!pagination||pagination.next_page_url!==null||!Array.isArray(members.participants)||members.participants.length<3||members.participants.length>10)throw new Fault('group_membership_incomplete_or_limit',409)
 const participants=members.participants as {sid:string;account_sid:string;conversation_sid:string;messaging_binding?:{address?:string;proxy_address?:string;projected_address?:string}}[]
 if(participants.some(x=>x.account_sid!==source.account_id||x.conversation_sid!==conversation)||new Set(participants.map(x=>x.sid)).size!==participants.length)throw new Fault('group_participant_identity_mismatch',502)
 const business=participants.filter(x=>x.messaging_binding?.projected_address===source.e164&&!x.messaging_binding.address)
 const external=participants.filter(x=>x!==business[0])
 if(business.length!==1||external.some(x=>!/^\+1\d{10}$/.test(x.messaging_binding?.address??'')||x.messaging_binding?.projected_address||x.messaging_binding?.proxy_address))throw new Fault('group_business_binding_mismatch',409)
 const addresses=external.map(x=>phone(x.messaging_binding!.address)).sort()
 if(new Set(addresses).size!==addresses.length||addresses.includes(source.e164))throw new Fault('group_participant_identity_mismatch',409)
 const author=external.find(x=>x.sid===m.participant_sid&&x.messaging_binding?.address===m.author)
 if(!author||p.get('ParticipantSid')&&p.get('ParticipantSid')!==m.participant_sid)throw new Fault('group_author_not_verified',403)
 text(m.body??'','body',1600,true)
 const body=String(m.body??''),media=m.media??[]
 if(!Array.isArray(media)||media.length>10)throw new Fault('route_media_limit',409)
 const metadata=media.map(x=>{if(!x||typeof x!=='object'||typeof x.sid!=='string'||!['image/jpeg','image/png','image/gif'].includes(x.content_type)||!Number.isSafeInteger(x.size)||x.size<1||x.size>5000000)throw new Fault('invalid_group_media_metadata',502);return {sid:x.sid,mime:x.content_type,bytes:x.size,content:'metadata only; not fetched'}})
 if(metadata.reduce((n,m)=>n+m.bytes,0)>5000000)throw new Fault('route_media_size_limit',409)
 const occurred=Date.parse(String(m.date_created));if(!Number.isFinite(occurred))throw new Fault('provider_time_unavailable',503)
 const peer='group:'+conversation,t=await env.DB.prepare('SELECT * FROM hnd_message_threads WHERE source_id=? AND peer=?').bind(source.id,peer).first<Thread>(),key=t?.id??id()
 const old=await env.DB.prepare('SELECT body,media,participants FROM hnd_inbox_messages WHERE thread_id=? AND provider_sid=?').bind(key,sid).first<{body:string;media:string;participants:string}>()
 const encodedMedia=JSON.stringify(metadata),encodedParticipants=JSON.stringify([source.e164,...addresses])
 if(old){await env.DB.batch([sourceFence(env,source),current(env,r),env.DB.prepare('DELETE FROM hnd_guard')]);if(old.body!==body||old.media!==encodedMedia||old.participants!==encodedParticipants)throw new Fault('group_message_conflict',409);return {threadId:key,replay:true,sendAuthorized:false}}
 const statements=[sourceFence(env,source),current(env,r)]
 if(!t)statements.push(env.DB.prepare("INSERT INTO hnd_message_threads(id,source_id,business,peer,owner_id,revision,custody,updated_at,route_kind,participants) VALUES (?,?,?,?,NULL,1,'handset',?,'conversations',?)").bind(key,source.id,source.e164,peer,Date.now(),encodedParticipants))
 statements.push(env.DB.prepare('INSERT INTO hnd_inbox_messages VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id(),key,sid,'inbound',body,encodedMedia,encodedParticipants,'received','not applicable',occurred),env.DB.prepare('UPDATE hnd_message_threads SET participants=?,updated_at=? WHERE id=?').bind(encodedParticipants,Date.now(),key),env.DB.prepare('INSERT INTO hnd_message_history VALUES (?,?,?,NULL,?)').bind(id(),key,'Group message metadata received',Date.now()))
 if(/^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(body))statements.push(env.DB.prepare("INSERT INTO hnd_protection_stops VALUES (?,?,?,'all','consent_revoked',?,?) ON CONFLICT(number_id,recipient,channel,reason) DO NOTHING").bind(id(),source.number_id,String(m.author),source.id,Date.now()))
 await append(env,source.id,'message.receive',key,'completed',statements,null,sourcePolicy(source))
 return {threadId:key,replay:false,sendAuthorized:false}
}
export async function groupProviderResponse(request:Request,original:Bindings):Promise<Response|null> {
 const url=new URL(request.url)
 if(url.pathname!=='/providers/twilio/messages/groups')return null
 const env=runtimeBindings(original)
 try {
  if(url.origin!==env.AUTH_ORIGIN||url.search||request.headers.has('host')&&request.headers.get('host')?.toLowerCase()!==url.host.toLowerCase())throw new Fault('invalid_source_proof',403)
  if(request.method!=='POST')throw new Fault('method_not_allowed',405)
  if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new Fault('invalid_source_content_type',415)
  const p=new URLSearchParams(new TextDecoder().decode(await boundedBody(request,65536)))
  await verifyCarrierSignature(request,env,p)
  return json(await receive(env,p))
 }catch(error){if(error instanceof Fault)return json({error:error.code},error.status);if(/UNIQUE constraint|CHECK constraint/.test(String(error)))return json({error:'group_state_changed'},409);return json({error:'group_readback_unavailable'},503)}
}
