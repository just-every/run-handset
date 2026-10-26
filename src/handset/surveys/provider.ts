import { runtimeBindings, type Bindings } from '../../auth.server'
import { escape, Fault, json, text } from '../core'
import { sql } from '../delegation/store'
import { verifyCarrierSignature } from '../protection/carrier-proof'
import { xml } from '../protection/twiml'
import { capturePermission, ensureCall, readTwilio } from '../consent/store'
import { enqueueText } from '../consent/texts'
import { change, context, response, syncDelivery, type Context } from './store'
const root='/providers/twilio/surveys/'
const done=()=>xml('<Say>Thank you. Goodbye.</Say><Hangup/>')
function prompt(c:Context){return `${c.policy.business_name}: Would you like to give optional feedback about this call? Press 1 to ${c.invitation.channel==='sms'?'receive one survey text':'rate this call from 1 to 5'}. Press 2 to decline. This does not sign you up for marketing.`}
function rating(c:Context){return xml(`<Gather action="${root}${c.invitation.id}/rating" method="POST" numDigits="1" timeout="8"><Say>Please rate your experience from 1 to 5, where 1 is very dissatisfied and 5 is very satisfied.</Say></Gather><Say>No rating was recorded. Goodbye.</Say><Hangup/>`)}
export async function surveyProviderResponse(request:Request,original:Bindings):Promise<Response|null>{
 const url=new URL(request.url)
 if(!url.pathname.startsWith(root))return null
 const env=runtimeBindings(original)
 try{
  const match=url.pathname.match(/^\/providers\/twilio\/surveys\/([0-9a-f-]{36})(?:\/(consent|rating|reply))?$/)
  if(!match)throw new Fault('not_found',404)
  if(url.origin!==env.AUTH_ORIGIN||url.search||request.headers.has('host')&&request.headers.get('host')?.toLowerCase()!==url.host.toLowerCase())throw new Fault('invalid_source_proof',403)
  if(request.method!=='POST')throw new Fault('method_not_allowed',405)
  if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new Fault('invalid_source_content_type',415)
  if(Number(request.headers.get('content-length')??0)>16384)throw new Fault('body_too_large',413)
  const raw=await request.text();if(new TextEncoder().encode(raw).length>16384)throw new Fault('body_too_large',413)
  const p=new URLSearchParams(raw);await verifyCarrierSignature(request,env,p)
  const c=await context(env,match[1]),i=c.invitation,action=match[2]
  if(p.get('AccountSid')!==c.source.account_id||p.get('From')!==c.call.caller||p.get('To')!==c.call.business)throw new Fault('survey_identity_mismatch',403)
  if(action==='reply'){
   if(i.channel!=='sms')throw new Fault('sms_survey_required',409)
   const sid=text(p.get('MessageSid'),'MessageSid',40),body=text(p.get('Body'),'Body',1100)
   const receipt=await readTwilio(env,c.source,`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.source.account_id)}/Messages/${sid}.json`)
   if(receipt.sid!==sid||receipt.account_sid!==c.source.account_id||receipt.from!==c.call.caller||receipt.to!==c.call.business||receipt.direction!=='inbound'||receipt.body!==p.get('Body')||!['received','receiving'].includes(String(receipt.status)))throw new Fault('survey_reply_readback_mismatch',403)
   const accepted=body.match(/^([1-5])(?:\s+([\s\S]{1,1000}))?$/)
   if(!accepted)return xml('')
   await syncDelivery(env,c)
   await response(env,c,Number(accepted[1]),accepted[2]?.trim()??'','sms:'+sid)
   return xml('')
  }
  if(p.get('CallSid')!==c.call.call_sid||p.has('MessageSid'))throw new Fault('survey_voice_identity_mismatch',403)
  if(!await sql(env,'SELECT call_id FROM hnd_consent_conversations WHERE call_id=?',c.call.id).first())throw new Fault('post_call_conversation_required',409)
  const verified=await ensureCall(env,c.source.id,p)
  if(verified.id!==c.call.id)throw new Fault('survey_call_context_mismatch',403)
  if(i.expires_at<=Date.now()||i.suppressed_at)return done()
  if(await sql(env,'SELECT invitation_id FROM hnd_survey_responses WHERE invitation_id=?',i.id).first())return done()
  if(!action)return xml(`<Gather action="${root}${i.id}/consent" method="POST" numDigits="1" timeout="8"><Say>${escape(prompt(c))}</Say></Gather><Say>No survey was requested. Goodbye.</Say><Hangup/>`)
  if(action==='consent'){
   const digits=p.get('Digits')
   if(digits!=='1'&&digits!=='2')return done()
   const permission=await capturePermission(env,c.call,'survey',digits==='1'?'granted':'declined',prompt(c),{invitationId:i.id,channel:i.channel,digits})
   await change(env,c,'survey.consent',[sql(env,'UPDATE hnd_survey_invitations SET permission_id=COALESCE(permission_id,?) WHERE id=?',permission.id,i.id)])
   i.permission_id=permission.id
   if(permission.state==='declined')return done()
   if(i.channel==='sms'){
    const message=await enqueueText(env,permission.id,`${c.policy.business_name}: Please rate your experience on this call from 1 (very dissatisfied) to 5 (very satisfied). Reply with a number and an optional comment. Reply STOP to stop texts.`,i.expires_at)
    await change(env,c,'survey.enqueue',[sql(env,'UPDATE hnd_survey_invitations SET text_id=COALESCE(text_id,?) WHERE id=?',message.id,i.id)])
    return xml('<Say>Thank you. Your optional survey text has been requested. Goodbye.</Say><Hangup/>')
   }
   await change(env,c,'survey.deliver',[sql(env,'UPDATE hnd_survey_invitations SET eligible_at=COALESCE(eligible_at,?) WHERE id=?',Date.now(),i.id)])
   return rating(c)
  }
  if(action==='rating'){
   if(i.channel!=='ivr')throw new Fault('ivr_survey_required',409)
   const digits=p.get('Digits')
   if(!digits||!/^[1-5]$/.test(digits))return done()
   await response(env,c,Number(digits),'','ivr:'+c.call.call_sid+':'+i.id)
   return done()
  }
  throw new Fault('not_found',404)
 }catch(error){
  if(error instanceof Fault)return json({error:error.code,effectOccurred:false},error.status)
  if(/CHECK constraint failed|UNIQUE constraint failed/.test(String(error)))return json({error:'survey_state_changed',effectOccurred:false},409)
  return json({error:'survey_unavailable',effectOccurred:false},503)
 }
}

/** Called only after canonical signed ingress has validated and stored the
 * message. Shared-number replies are correlated without changing webhook URLs
 * for each invitation; ambiguous outstanding surveys refuse a rating. */
export async function surveyIncoming(env:Bindings,sourceId:string,p:URLSearchParams) {
 const sid=p.get('MessageSid'),from=p.get('From'),to=p.get('To'),body=p.get('Body')??''
 if(!sid||!/^\s*[1-5](?:\s|$)/.test(body))return
 const replay=await sql(env,'SELECT invitation_id FROM hnd_survey_responses WHERE provider_event=?','sms:'+sid).first<{invitation_id:string}>()
 const rows=replay?[{id:replay.invitation_id}]:(await sql(env,`SELECT i.id FROM hnd_survey_invitations i JOIN hnd_consent_calls c ON c.id=i.call_id WHERE i.source_id=? AND i.channel='sms' AND c.caller=? AND c.business=? AND i.expires_at>? AND i.permission_id IS NOT NULL AND i.suppressed_at IS NULL AND NOT EXISTS(SELECT 1 FROM hnd_survey_responses r WHERE r.invitation_id=i.id)`,sourceId,from,to,Date.now()).all<{id:string}>()).results
 if(rows.length!==1)return
 const c=await context(env,rows[0].id)
 const receipt=await readTwilio(env,c.source,`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.source.account_id)}/Messages/${encodeURIComponent(sid)}.json`)
 if(receipt.sid!==sid||receipt.account_sid!==c.source.account_id||receipt.from!==from||receipt.to!==to||receipt.direction!=='inbound'||receipt.body!==body||!['received','receiving'].includes(String(receipt.status)))throw new Fault('survey_reply_readback_mismatch',403)
 await syncDelivery(env,c)
 const accepted=body.trim().match(/^([1-5])(?:\s+([\s\S]{1,1000}))?$/)
 if(accepted)await response(env,c,Number(accepted[1]),accepted[2]?.trim()??'','sms:'+sid)
}
