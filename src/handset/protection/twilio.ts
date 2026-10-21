import { runtimeBindings, type Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { escape, Fault, headers, json, text } from '../core'
import { admitProtection, nativeNumber } from './admission'
import type { Route } from './model'
interface Source {id:string;number_id:string;owner_id:string;owner_version:number;revision:number}
const endpoint='/providers/twilio/protection'
const xml=(body:string)=>new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,{headers:{...headers,'content-type':'application/xml; charset=utf-8'}})
async function signed(request:Request,env:Bindings,p:URLSearchParams){
 const signature=request.headers.get('x-twilio-signature')
 if(!env.HANDSET_TWILIO_AUTH_TOKEN||!signature||!/^[A-Za-z0-9+/]{27}=$/.test(signature))throw new Fault('invalid_source_proof',403)
 let raw:Uint8Array;try{raw=Uint8Array.from(atob(signature),c=>c.charCodeAt(0))}catch{throw new Fault('invalid_source_proof',403)}
 let payload=request.url
 for(const name of [...new Set(p.keys())].sort())for(const value of [...new Set(p.getAll(name))].sort())payload+=name+value
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.HANDSET_TWILIO_AUTH_TOKEN),{name:'HMAC',hash:'SHA-1'},false,['verify'])
 if(!await crypto.subtle.verify('HMAC',key,new Uint8Array(raw).buffer,new TextEncoder().encode(payload)))throw new Fault('invalid_source_proof',403)
 for(const name of p.keys())if(p.getAll(name).length!==1)throw new Fault('duplicate_source_field')
}
function destination(value:string){
 if(!value.startsWith('sip:'))return value
 const m=value.match(/^sip:(\+?[0-9]+)@[A-Za-z0-9.-]+(?::[0-9]+)?(?:;[A-Za-z0-9=;.-]+)?$/)
 if(!m)throw new Fault('unsupported_sip_destination')
 return m[1]
}
/** Official Twilio voice/SIP call-control webhook, separate from status ingestion.
 * No Dial/Message verb or paid API is emitted. Only explicitly approved existing
 * inbound/emergency flows are continued. See Twilio security, TwiML and SIP docs. */
export async function protectionCarrierResponse(request:Request,original:Bindings):Promise<Response|null>{
 if(new URL(request.url).pathname!==endpoint)return null
 const env=runtimeBindings(original),url=new URL(request.url)
 let source:Source|null=null
 try{
  if(url.origin!==env.AUTH_ORIGIN||url.search||request.headers.has('host')&&request.headers.get('host')?.toLowerCase()!==url.host.toLowerCase())throw new Fault('invalid_source_proof',403)
  if(request.method!=='POST')throw new Fault('method_not_allowed',405)
  if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new Fault('invalid_source_content_type',415)
  if(Number(request.headers.get('content-length')??0)>16384)throw new Fault('body_too_large',413)
  const raw=await request.text();if(new TextEncoder().encode(raw).length>16384)throw new Fault('body_too_large',413)
  const p=new URLSearchParams(raw);await signed(request,env,p)
  const account=text(p.get('AccountSid'),'AccountSid'),callId=text(p.get('CallSid'),'CallSid'),from=text(p.get('From'),'From'),to=text(p.get('To'),'To')
  source=await env.DB.prepare(`SELECT s.* FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id WHERE s.account_id=? AND s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=s.owner_version`).bind(account).first<Source>()
  if(!source)throw new Fault('invalid_source_proof',403)
  if(p.has('FaxSid')||p.has('MessageSid'))throw new Fault('voice_admission_required',422)
  if(p.get('Direction')!=='inbound')throw new Fault('initial_inbound_or_sip_webhook_required',422)
  if(p.get('CallStatus')!=='ringing')throw new Fault('initial_ringing_webhook_required',422)
  const route=await env.DB.prepare('SELECT * FROM hnd_protection_routes WHERE source_id=?').bind(source.id).first<Route>()
  if(!route)throw new Fault('admission_route_unconfigured',409)
  const sip=from.startsWith('sip:')||from.startsWith('client:')
  if(!sip&&to!==await nativeNumber(env,source.number_id))throw new Fault('source_number_out_of_scope',403)
  // Digest-auth username is provider reported. Without it, containment is
  // account scoped rather than treating a caller-controlled From as identity.
  const device=sip?source.id+':'+(p.get('SipUsername')?text(p.get('SipUsername'),'SipUsername',100):'unattributed-sip'):source.id+':inbound'
  const fences=[env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id WHERE s.id=? AND s.revision=? AND s.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=s.owner_version`).bind(source.id,source.revision),env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_protection_routes WHERE source_id=? AND revision=?').bind(source.id,route.revision)]
  const verdict=await admitProtection(env,{principal:source.id,sourceId:source.id,eventKey:'voice:'+callId,numberId:source.number_id,deviceId:device,channel:'voice',direction:sip?'outbound':'inbound',address:sip?destination(to):from.toLowerCase()==='anonymous'?'anonymous':from,personalId:route.personal_id??undefined,authorized:false,consent:false,attemptedCents:sip?route.attempt_cents:0,fences})
  if(verdict.decision==='block')return xml('<Reject reason="rejected"/>')
  if(verdict.decision==='screen')return json({error:'screening_adapter_unqualified',decision:verdict,effectOccurred:false},503)
  const next=verdict.reason==='direct_emergency_call'?route.emergency_url:route.continuation_url
  if(!next)return json({error:verdict.reason==='direct_emergency_call'?'emergency_route_unqualified':'inbound_continuation_unconfigured',decision:verdict,effectOccurred:false},503)

  return xml(`<Redirect method="POST">${escape(next)}</Redirect>`)
 }catch(error){
  if(error instanceof Fault){if(source)await append(env,source.id,'protection.admit','installation','refused');return json({error:error.code,effectOccurred:false},error.status)}
  console.error('Handset protection admission failed',error instanceof Error?error.name:'unknown')
  return json({error:'protection_unavailable',effectOccurred:false},503)
 }
}
