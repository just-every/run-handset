import { runtimeBindings, type Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { escape as e, Fault, id, json, text } from '../core'
import { verifyCarrierSignature } from '../protection/carrier-proof'
import { xml } from '../protection/twiml'
import { callUrl, capturePermission, carePrompt, ensureCall, getCall, getPolicy, policyAuthority, readTwilio, type ConsentCall, type ConsentPolicy } from './store'
import { confirmText } from './texts'
import { missedCall } from './outcomes'

const root='/providers/twilio/consent'
function ring(env:Bindings,p:ConsentPolicy,call:ConsentCall) {
 return `<Dial timeout="20" action="${e(env.AUTH_ORIGIN+root+'/calls/'+call.id+'/outcome')}" method="POST"><Number>${e(p.staff_target)}</Number></Dial>`
}
async function verifyCall(env:Bindings,call:ConsentCall,p:URLSearchParams) {
 if(p.get('CallSid')!==call.call_sid||p.get('From')!==call.caller||p.get('To')!==call.business)throw new Fault('consent_call_identity_mismatch',403)
 const policy=await getPolicy(env,call.policy_id),{source}=await policyAuthority(env,policy)
 if(p.get('AccountSid')!==source.account_id)throw new Fault('consent_account_mismatch',403)
 return {policy,source}
}
export async function consentProviderResponse(request:Request,original:Bindings):Promise<Response|null> {
 const url=new URL(request.url),path=url.pathname
 if(path!==root&&!path.startsWith(root+'/'))return null
 const env=runtimeBindings(original)
 try {
  if(url.origin!==env.AUTH_ORIGIN||url.search||request.headers.has('host')&&request.headers.get('host')?.toLowerCase()!==url.host.toLowerCase())throw new Fault('invalid_source_proof',403)
  if(request.method!=='POST')throw new Fault('method_not_allowed',405)
  if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new Fault('invalid_source_content_type',415)
  const raw=await request.text();if(new TextEncoder().encode(raw).length>16384)throw new Fault('body_too_large',413)
  const p=new URLSearchParams(raw);await verifyCarrierSignature(request,env,p)
  const receipt=path.match(/^\/providers\/twilio\/consent\/texts\/([0-9a-f-]{36})\/status$/)
  if(receipt) {
   const sid=text(p.get('MessageSid'),'MessageSid'),row=await confirmText(env,receipt[1],sid)
   return json({text:row})
  }
  const start=path.match(/^\/providers\/twilio\/consent\/([0-9a-f-]{36})$/)
  if(start) {
   const call=await ensureCall(env,start[1],p),policy=await getPolicy(env,call.policy_id)
   return xml(`<Gather input="dtmf" numDigits="1" timeout="5" actionOnEmptyResult="true" action="${e(env.AUTH_ORIGIN+root+'/calls/'+call.id+'/decision')}" method="POST"><Say>${e(carePrompt(policy))}</Say></Gather>`)
  }
  const action=path.match(/^\/providers\/twilio\/consent\/calls\/([0-9a-f-]{36})\/(decision|outcome)$/)
  if(!action)throw new Fault('not_found',404)
  const call=await getCall(env,action[1]),{policy,source}=await verifyCall(env,call,p)
  if(action[2]==='decision') {
   await ensureCall(env,call.source_id,p)
   await capturePermission(env,call,'one_reply',p.get('Digits')==='1'?'granted':'declined',carePrompt(policy),{kind:'dtmf',digits:p.get('Digits')??'',source:'signed Twilio Gather',serverTimestamp:Date.now()})
   return xml(ring(env,policy,call))
  }
  const sid=text(p.get('DialCallSid'),'DialCallSid'),status=text(p.get('DialCallStatus'),'DialCallStatus')
  const [parent,child]=await Promise.all([readTwilio(env,source,callUrl(source,call.call_sid)),readTwilio(env,source,callUrl(source,sid))])
  if(parent.sid!==call.call_sid||parent.account_sid!==source.account_id||parent.from!==call.caller||parent.to!==call.business||parent.direction!=='inbound'||child.sid!==sid||child.account_sid!==source.account_id||child.parent_call_sid!==call.call_sid||child.from!==call.business||child.to!==policy.staff_target||child.status!==status)throw new Fault('missed_leg_readback_mismatch',502)
  if(!['no-answer','busy','failed','canceled'].includes(status)) {
   if(status!=='completed')throw new Fault('call_outcome_not_terminal',409)
   const invitation=await env.DB.prepare('SELECT id FROM hnd_survey_invitations WHERE call_id=? AND expires_at>? AND suppressed_at IS NULL').bind(call.id,Date.now()).first<{id:string}>()
   return invitation?xml(`<Redirect method="POST">${e(env.AUTH_ORIGIN+'/providers/twilio/surveys/'+invitation.id)}</Redirect>`):xml('<Hangup/>')
  }
  const existing=await env.DB.prepare('SELECT call_record_id FROM hnd_consent_outcomes WHERE call_id=?').bind(call.id).first<{call_record_id:string}>()
  if(existing)return xml('<Hangup/>')
  const native=await env.DB.prepare('SELECT record_id,case_id FROM hnd_source_objects WHERE source_id=? AND external_id=?').bind(source.id,call.call_sid).first<{record_id:string;case_id:string}>()
  if(!native)throw new Fault('verified_parent_required',409)
  const missedAt=Date.parse(String(child.end_time))
  if(!Number.isFinite(missedAt)||missedAt>Date.now()+1000)throw new Fault('missed_outcome_time_required',409)
  const recordId=id(),{fences}=await policyAuthority(env,policy)
  await append(env,source.id,'consent.outcome',call.id,'completed',[...fences,env.DB.prepare('INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(recordId,'provider_attempt','native','consent-missed:'+call.id,missedAt,Date.now(),native.case_id,native.record_id,null,JSON.stringify({objectKind:'call_leg',providerStatus:status,direction:'inbound',from:call.caller,to:call.business,callSid:call.call_sid,legSid:sid,customerOutcome:'unconfirmed'}),source.id),env.DB.prepare('INSERT INTO hnd_record_sources VALUES (?,?,?,?)').bind(recordId,source.id,'twilio','consent-missed:'+sid)],null,sourcePolicy(source))
  await missedCall(env,call,recordId,missedAt)
  return xml('<Hangup/>')
 } catch(error) {
  if(error instanceof Fault)return json({error:error.code},error.status)
  if(/UNIQUE constraint|CHECK constraint/.test(String(error)))return json({error:'consent_state_changed'},409)
  console.error('Handset consent provider failed',error instanceof Error?error.name:'unknown')
  return json({error:'consent_unavailable'},503)
 }
}
