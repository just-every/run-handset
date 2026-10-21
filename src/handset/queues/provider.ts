import { runtimeBindings, type Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { Fault, headers, json, text } from '../core'
import { boundSource, sourceContext, verifyQueueRequest, type BoundSource } from './provider-proof'
import { continueVoice, voiceInstructions } from './provider-response'
import { offerById } from './offers'
import { recoverOffer } from './offer-readback'
import { entry } from './storage'

const xml=(body:string)=>new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,{headers:{...headers,'content-type':'application/xml; charset=utf-8'}})
/** Twilio Voice URL + Dial noun status callbacks + Dial action, with independent
 * signature/source consent and authoritative parent/child resource readback.
 * https://www.twilio.com/docs/voice/twiml/dial
 * https://www.twilio.com/docs/voice/twiml/client
 * https://www.twilio.com/docs/voice/twiml/sip
 */
export async function queueProviderResponse(request:Request,original:Bindings):Promise<Response|null>{
 const url=new URL(request.url),match=url.pathname.match(/^\/providers\/twilio\/queues\/([0-9a-f-]{36})(?:\/offers\/([0-9a-f-]{36})\/(status|action))?$/)
 if(!match)return null
 const env=runtimeBindings(original);let knownSource:BoundSource|null=null
 try{
  if(url.origin!==env.AUTH_ORIGIN||url.search||request.headers.has('host')&&request.headers.get('host')?.toLowerCase()!==url.host.toLowerCase())throw new Fault('invalid_queue_source_proof',403)
  if(request.method!=='POST')throw new Fault('method_not_allowed',405)
  if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new Fault('invalid_source_content_type',415)
  const body=await request.text();if(new TextEncoder().encode(body).length>16384)throw new Fault('body_too_large',413)
  const p=new URLSearchParams(body)
  await verifyQueueRequest(request,env,p)
  const source=await boundSource(env,match[1]);knownSource=source
  if(!source||p.get('AccountSid')!==source.account_id)throw new Fault('invalid_queue_source_proof',403)
  const ctx=sourceContext(env,source)
  if(match[2]){
   const offer=await offerById(ctx,match[2])
   if(offer.binding_id!==source.id||offer.source_id!==source.source_id)throw new Fault('queue_offer_source_mismatch',403)
   const action=match[3]==='action',sid=text(p.get('CallSid'),'CallSid')
   if(action&&sid!==offer.parent_call_sid||!action&&p.get('ParentCallSid')!==offer.parent_call_sid)throw new Fault('queue_parent_identity_mismatch',403)
   const child=action?(p.get('DialCallSid')?text(p.get('DialCallSid'),'DialCallSid'):undefined):sid
   await recoverOffer(ctx,offer,child,action&&p.get('DialBridged')!=='true'?p.get('DialCallStatus')??undefined:undefined)
   if(!action)return new Response(null,{status:204,headers})
   return xml(await continueVoice(ctx,source,await entry(ctx,offer.entry_id),offer.parent_call_sid))
  }
  text(p.get('CallSid'),'CallSid')
  return xml(await voiceInstructions(ctx,source,p))
 }catch(error){
  if(error instanceof Fault){if(knownSource)await append(env,knownSource.source_id,'source.refuse','installation','refused');return json({error:error.code,...(error.detail?{detail:error.detail}:{})},error.status)}
  if(String(error).includes('CHECK constraint failed'))return json({error:'queue_authority_changed'},409)
  if(/UNIQUE constraint failed/.test(String(error)))return json({error:'queue_state_conflict'},409)
  console.error('Handset queue provider request failed',error instanceof Error?error.name:'unknown')
  return json({error:'queue_source_unavailable'},503)
 }
}
