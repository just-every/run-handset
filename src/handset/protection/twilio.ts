import { runtimeBindings, type Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { escape, Fault, json, text } from '../core'
import { admitProtection, nativeNumber } from './admission'
import type { Route } from './model'
import { verifyCarrierSignature, sourceFence, routeFence, type Source } from './carrier-proof'
import { initialChallengeResponse, answerChallenge } from './challenges'
import { xml } from './twiml'
const endpoint='/providers/twilio/protection'
function destination(value:string){
 if(!value.startsWith('sip:'))return value
 const m=value.match(/^sip:(\+?[0-9]+)@[A-Za-z0-9.-]+(?::[0-9]+)?(?:;[A-Za-z0-9=;.-]+)?$/)
 if(!m)throw new Fault('unsupported_sip_destination')
 return m[1]
}
/** Official Twilio voice/SIP call-control webhook, separate from status ingestion.
 * Existing inbound/emergency flows continue under protection. Executive-line
 * Dial requires separate exact owner-approved routing. No Message or REST write
 * is emitted. See Twilio security, TwiML and SIP docs. */
export async function protectionCarrierResponse(request:Request,original:Bindings):Promise<Response|null>{
 const path=new URL(request.url).pathname
 const challenge=path.match(/^\/providers\/twilio\/protection\/challenges\/([0-9a-f-]{36})\/([1-3])$/)
 if(path!==endpoint&&!path.startsWith(endpoint+'/challenges/'))return null
 const env=runtimeBindings(original),url=new URL(request.url)
 let source:Source|null=null
 try{
  if(path!==endpoint&&!challenge)throw new Fault('not_found',404)
  if(url.origin!==env.AUTH_ORIGIN||url.search||request.headers.has('host')&&request.headers.get('host')?.toLowerCase()!==url.host.toLowerCase())throw new Fault('invalid_source_proof',403)
  if(request.method!=='POST')throw new Fault('method_not_allowed',405)
  if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new Fault('invalid_source_content_type',415)
  if(Number(request.headers.get('content-length')??0)>16384)throw new Fault('body_too_large',413)
  const raw=await request.text();if(new TextEncoder().encode(raw).length>16384)throw new Fault('body_too_large',413)
  const p=new URLSearchParams(raw);await verifyCarrierSignature(request,env,p)
  const account=text(p.get('AccountSid'),'AccountSid'),callId=text(p.get('CallSid'),'CallSid'),from=text(p.get('From'),'From'),to=text(p.get('To'),'To')
  const sources=(await env.DB.prepare(`SELECT s.*,json_extract(n.data,'$.e164') AS e164 FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id JOIN hnd_records n ON n.id=s.number_id WHERE s.account_id=? AND s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=s.owner_version AND NOT EXISTS(SELECT 1 FROM hnd_sources newer WHERE newer.account_id=s.account_id AND newer.number_id=s.number_id AND newer.revision>s.revision) AND NOT EXISTS(SELECT 1 FROM hnd_records correction WHERE correction.supersedes_id=n.id)`).bind(account).all<Source&{e164:string}>()).results
  const sipFrom=from.startsWith('sip:')||from.startsWith('client:')
  const matches=sipFrom?sources:sources.filter(s=>s.e164===to)
  if(matches.length!==1)throw new Fault('invalid_source_proof',403)
  source=matches[0]
  if(!source)throw new Fault('invalid_source_proof',403)
  if(p.has('FaxSid')||p.has('MessageSid'))throw new Fault('voice_admission_required',422)
  if(p.get('Direction')!=='inbound')throw new Fault('initial_inbound_or_sip_webhook_required',422)
  if(p.get('CallStatus')!==(challenge?'in-progress':'ringing'))throw new Fault(challenge?'active_screening_call_required':'initial_ringing_webhook_required',422)
  const route=await env.DB.prepare('SELECT * FROM hnd_protection_routes WHERE source_id=?').bind(source.id).first<Route>()
  if(!route)throw new Fault('admission_route_unconfigured',409)
  const sip=from.startsWith('sip:')||from.startsWith('client:')
  if(!sip&&to!==await nativeNumber(env,source.number_id))throw new Fault('source_number_out_of_scope',403)
  // Digest-auth username is provider reported. Without it, containment is
  // account scoped rather than treating a caller-controlled From as identity.
  const device=sip?source.id+':'+(p.get('SipUsername')?text(p.get('SipUsername'),'SipUsername',100):'unattributed-sip'):source.id+':inbound'
  const context={source,route,callId,from,to}
  if(challenge){
   if(sip)throw new Fault('inbound_pstn_screening_required',422)
   return await answerChallenge(env,context,challenge[1],Number(challenge[2]),p.get('Digits'))
  }
  const fences=[sourceFence(env,source),routeFence(env,route)]
  const verdict=await admitProtection(env,{principal:source.id,sourceId:source.id,eventKey:'voice:'+callId,numberId:source.number_id,deviceId:device,channel:'voice',direction:sip?'outbound':'inbound',address:sip?destination(to):from.toLowerCase()==='anonymous'?'anonymous':from,personalId:route.personal_id??undefined,authorized:false,consent:false,attemptedCents:sip?route.attempt_cents:0,fences})
  if(!sip){const screening=await initialChallengeResponse(env,context);if(screening)return screening}
  if(verdict.decision==='block')return xml('<Reject reason="rejected"/>')
  const next=verdict.reason==='direct_emergency_call'?route.emergency_url:route.continuation_url
  if(!next)return json({error:verdict.reason==='direct_emergency_call'?'emergency_route_unqualified':'inbound_continuation_unconfigured',decision:verdict,effectOccurred:false},503)

  return xml(`<Redirect method="POST">${escape(next)}</Redirect>`)
 }catch(error){
  if(error instanceof Fault){if(source)await append(env,source.id,'protection.admit','installation','refused');return json({error:error.code,effectOccurred:false},error.status)}
  if(/CHECK constraint failed|challenge_already_terminal|UNIQUE constraint failed: hnd_protection_challenges/.test(String(error)))return json({error:'screening_state_changed',effectOccurred:false},409)
  console.error('Handset protection admission failed',error instanceof Error?error.name:'unknown')
  return json({error:'protection_unavailable',effectOccurred:false},503)
 }
}
