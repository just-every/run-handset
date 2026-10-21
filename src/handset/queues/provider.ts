import { runtimeBindings, type Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { escape as e, Fault, headers, json, text } from '../core'
import { enqueue, entryAction } from './entries'
import { announcement } from './read'
import { dispatch, reconcile } from './routing'
import { entry, statement } from './storage'
import { sourceCall, sourceContext, verifyQueueRequest, type BoundSource } from './provider-proof'
import type { Entry } from './model'

const xml=(body:string)=>new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,{headers:{...headers,'content-type':'application/xml; charset=utf-8'}})
/** Official Twilio Voice URL request / TwiML response, protected independently of browser sessions.
 * Schema: https://www.twilio.com/docs/voice/twiml/say and /redirect, /pause.
 * Emitted instructions are NOT a provider receipt of spoken or connected audio.
 */
export async function queueProviderResponse(request:Request,original:Bindings):Promise<Response|null>{
 const url=new URL(request.url),match=url.pathname.match(/^\/providers\/twilio\/queues\/([0-9a-f-]{36})$/)
 if(!match)return null
 const env=runtimeBindings(original);let knownSource:BoundSource|null=null
 try{
  if(url.origin!==env.AUTH_ORIGIN||url.search||request.headers.has('host')&&request.headers.get('host')?.toLowerCase()!==url.host.toLowerCase())throw new Fault('invalid_queue_source_proof',403)
  if(request.method!=='POST')throw new Fault('method_not_allowed',405)
  if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new Fault('invalid_source_content_type',415)
  const body=await request.text();if(new TextEncoder().encode(body).length>16384)throw new Fault('body_too_large',413)
  const parameters=new URLSearchParams(body)
  await verifyQueueRequest(request,env,parameters)
  const source=await env.DB.prepare(`SELECT b.*,s.account_id,s.number_id,s.owner_id AS source_owner_id,s.owner_version AS source_owner_version,s.revision AS source_revision,n.data AS number_data FROM hnd_queue_bindings b JOIN hnd_sources s ON s.id=b.source_id JOIN hnd_records n ON n.id=s.number_id JOIN oa_operators bo ON bo.id=b.owner_id JOIN oa_operators so ON so.id=s.owner_id WHERE b.id=? AND b.revoked_at IS NULL AND s.revoked_at IS NULL AND bo.status='active' AND bo.role='owner' AND bo.version=b.owner_version AND so.status='active' AND so.role='owner' AND so.version=s.owner_version`).bind(match[1]).first<BoundSource>()
  knownSource=source
  if(!source||parameters.get('AccountSid')!==source.account_id)throw new Fault('invalid_queue_source_proof',403)
  const state=text(parameters.get('CallStatus'),'CallStatus')
  if(!['queued','ringing','in-progress','completed','busy','failed','no-answer','canceled'].includes(state))throw new Fault('invalid_call_status')
  const ctx=sourceContext(env,source),callId=await sourceCall(ctx,source,parameters)
  let current=await statement(ctx,'SELECT * FROM hnd_queue_entries WHERE call_id=?',callId).first<Entry>()
  if(['completed','busy','failed','no-answer','canceled'].includes(state)){
   if(current&&['waiting','reserved','active'].includes(current.state))await entryAction(ctx,current.id,current.state==='active'&&state==='completed'?'complete':'abandon',{revision:current.revision})
   return xml('<Hangup/>')
  }
  if(!current){
   const lang=parameters.get('Digits')===source.spanish_digit?'es':source.language
   current=(await enqueue(ctx,source.queue_id,{callId,language:lang,skills:[],priority:0})).entry
  }
  if(['waiting','reserved'].includes(current.state)){
   await reconcile(ctx,current.queue_id)
   current=await entry(ctx,current.id)
   if(current.state==='waiting'){await dispatch(ctx,current.queue_id);current=await entry(ctx,current.id)}
  }
  if(current.state==='overflow'){
   const spanish=current.language.startsWith('es'),destination=current.overflow_kind==='voicemail'?(spanish?'buzón de voz':'voicemail'):current.overflow_kind==='receptionist'?(spanish?'recepcionista':'receptionist'):(spanish?'otra cola':'another queue')
   const message=spanish?`Su tiempo de espera ha terminado. La ruta seleccionada de ${destination} aún no está disponible. Por favor, vuelva a llamar.`:`Your queue wait has ended. The selected ${destination} route is not available on this installation yet. Please call again.`
   return xml(`<Say language="${spanish?'es-MX':'en-US'}">${e(message)}</Say><Hangup/>`)
  }
  if(['completed','abandoned'].includes(current.state))return xml('<Hangup/>')
  const prepared=await announcement(ctx,current),spanish=current.language.startsWith('es')
  if(!prepared)throw new Fault('carrier_bridge_unqualified',409)
  // One-second polls keep the native deadline responsive. Actual provider
  // execution latency and audio receipt remain unknown until live acceptance.
  return xml(`<Say language="${spanish?'es-MX':'en-US'}">${e(prepared.text)}</Say><Pause length="1"/><Redirect method="POST">${e(url.origin+url.pathname)}</Redirect>`)
 }catch(error){
  if(error instanceof Fault){if(knownSource)await append(env,knownSource.source_id,'source.refuse','installation','refused');return json({error:error.code},error.status)}
  if(String(error).includes('CHECK constraint failed'))return json({error:'queue_authority_changed'},409)
  if(/UNIQUE constraint failed/.test(String(error)))return json({error:'queue_state_conflict'},409)
  console.error('Handset queue provider request failed',error instanceof Error?error.name:'unknown')
  return json({error:'queue_source_unavailable'},503)
 }
}
