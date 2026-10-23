import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { escape, Fault, id } from '../core'
import { address, type Admission, type Route } from './model'
import { sourceFence, routeFence, type Source } from './carrier-proof'
import { challengePolicy } from './challenge-policy'
import { xml } from './twiml'
import { executiveContinuation } from '../delegation/inbound'

export interface ChallengeContext {source:Source;route:Route;callId:string;from:string;to:string}
interface Challenge {
 id:string;source_id:string;source_revision:number;owner_id:string;owner_version:number;account_id:string;
 number_id:string;caller:string;called_number:string;call_sid:string;rule_id:string;route_revision:number;
 digit:string;attempts:number;round:number;status:'pending'|'passed'|'failed'|'expired'|'cancelled';expires_at:number;last_outcome:string
}
const base='/providers/twilio/protection/challenges'
const applied=(c:ChallengeContext,ruleId?:string)=>({...sourcePolicy(c.source),route:{id:c.route.source_id,revision:c.route.revision},...(ruleId?{rule:{id:ruleId,revision:1}}:{})})
const digit=()=>String(crypto.getRandomValues(new Uint8Array(1))[0]%9+1)
const admission=(c:ChallengeContext):Admission=>({principal:c.source.id,sourceId:c.source.id,eventKey:'voice:'+c.callId,numberId:c.source.number_id,deviceId:c.source.id+':inbound',channel:'voice',direction:'inbound',address:address(c.from),personalId:c.route.personal_id??undefined})
const fences=(env:Bindings,c:ChallengeContext)=>[sourceFence(env,c.source),routeFence(env,c.route)]
const byCall=(env:Bindings,c:ChallengeContext)=>env.DB.prepare('SELECT * FROM hnd_protection_challenges WHERE source_id=? AND call_sid=?').bind(c.source.id,c.callId).first<Challenge>()
function scoped(row:Challenge,c:ChallengeContext){
 if(row.source_id!==c.source.id||row.account_id!==c.source.account_id||row.call_sid!==c.callId||row.number_id!==c.source.number_id||row.caller!==c.from||row.called_number!==c.to)throw new Fault('screening_call_scope_mismatch',403)
 if(row.source_revision!==c.source.revision||row.owner_id!==c.source.owner_id||row.owner_version!==c.source.owner_version)throw new Fault('screening_authority_changed',409)
}
// Twilio Gather uses a separate signed action request carrying standard voice
// fields plus Digits. Empty input submits too, so it consumes a bounded attempt.
// https://www.twilio.com/docs/voice/twiml/gather
function gather(env:Bindings,row:Challenge){
 const action=env.AUTH_ORIGIN+base+'/'+row.id+'/'+row.round
 const reason=row.attempts?row.last_outcome:'screening_digit_required'
 const en=reason==='screening_no_digit'?'No digit was received. ':reason==='screening_wrong_digit'?'That digit did not match. ':''
 const es=reason==='screening_no_digit'?'No se recibió ningún dígito. ':reason==='screening_wrong_digit'?'Ese dígito no coincide. ':''
 return xml(`<Gather input="dtmf" numDigits="1" timeout="5" finishOnKey="" actionOnEmptyResult="true" method="POST" action="${escape(action)}"><Say voice="man" language="en-US">${en}To continue this call, press ${row.digit}.</Say><Say voice="man" language="es-US">${es}Para continuar esta llamada, marque ${row.digit}.</Say></Gather><Hangup/>`,reason)
}
const failed=(reason:string)=>xml('<Say voice="man" language="en-US">We could not complete this screening. Goodbye.</Say><Say voice="man" language="es-US">No se pudo completar esta verificación. Adiós.</Say><Hangup/>',reason)
const pendingFence=(env:Bindings,row:Challenge,unexpired=true)=>env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_protection_challenges WHERE id=? AND status='pending' AND round=? AND attempts=?${unexpired?" AND expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)":''}`).bind(row.id,row.round,row.attempts)
async function end(env:Bindings,c:ChallengeContext,row:Challenge,status:'failed'|'expired'|'cancelled',reason:string,policyFence?:D1PreparedStatement,attempts=row.attempts){
 await append(env,c.source.id,'protection.admit',row.id,'refused',[
  ...fences(env,c),...(policyFence?[policyFence]:[]),pendingFence(env,row,false),
  env.DB.prepare('UPDATE hnd_protection_challenges SET status=?,last_outcome=?,attempts=?,updated_at=? WHERE id=?').bind(status,reason,attempts,Date.now(),row.id),
 ],null,applied(c,row.rule_id))
 return failed(reason)
}
async function active(env:Bindings,c:ChallengeContext,row:Challenge){
 scoped(row,c)
 if(row.status!=='pending')throw new Fault('screening_already_terminal',409)
 if(row.expires_at<=Date.now())return end(env,c,row,'expired','screening_expired')
 return null
}
async function continueOnce(env:Bindings,c:ChallengeContext,row:Challenge,policyFence:D1PreparedStatement,reason:string,ruleId?:string,attempts=row.attempts){
 if(!c.route.continuation_url)return end(env,c,row,'cancelled','screening_continuation_unconfigured',policyFence,attempts)
 const executive=await executiveContinuation(env,c,[...fences(env,c),policyFence,pendingFence(env,row)])
 const now=Date.now()
 await append(env,c.source.id,'protection.admit',row.id,'completed',[
  ...fences(env,c),policyFence,pendingFence(env,row),
  env.DB.prepare(`UPDATE hnd_protection_challenges SET status='passed',last_outcome=?,attempts=?,updated_at=?,continued_at=?,continuation_url=?,continued_route_revision=? WHERE id=?`).bind(reason,attempts,now,now,c.route.continuation_url,c.route.revision,row.id),
 ],null,applied(c,ruleId))
 // A keypad response is an interaction signal, never human identity, consent,
 // outbound authority, or proof that the continuation was actually received.
 return xml(executive??`<Redirect method="POST">${escape(c.route.continuation_url)}</Redirect>`,reason)
}
/** Start or resume one existing challenge. Called for every initial PSTN request
 * so replaying the initial URL cannot issue a fresh challenge after completion. */
export async function initialChallengeResponse(env:Bindings,c:ChallengeContext):Promise<Response|null>{
 let row=await byCall(env,c)
 const policy=await challengePolicy(env,admission(c)),v=policy.verdict
 if(row){
  const terminal=await active(env,c,row);if(terminal)return terminal
  if(v.decision==='exempt'||v.reason==='allow_exception')return continueOnce(env,c,row,policy.fence,v.reason,v.ruleId)
  if(v.decision!=='screen'||v.ruleId!==row.rule_id)return end(env,c,row,'cancelled','screening_policy_changed',policy.fence)
  // Repeated initial requests return the same round and do not reset attempts.
  await append(env,c.source.id,'protection.admit',row.id,'completed',[...fences(env,c),policy.fence,pendingFence(env,row)],null,applied(c,v.ruleId))
  return gather(env,row)
 }
 if(v.decision==='block'){
  await append(env,c.source.id,'protection.admit','installation','refused',[...fences(env,c),policy.fence],null,applied(c,v.ruleId))
  return xml('<Reject reason="rejected"/>',v.reason)
 }
 if(v.decision==='allow'||v.decision==='exempt'){
  if(!c.route.continuation_url)throw new Fault('inbound_continuation_unconfigured',503)
  const executive=await executiveContinuation(env,c,[...fences(env,c),policy.fence])
  await append(env,c.source.id,'protection.admit','installation','completed',[...fences(env,c),policy.fence],null,applied(c,v.ruleId))
  return xml(executive??`<Redirect method="POST">${escape(c.route.continuation_url)}</Redirect>`,v.reason)
 }
 if(v.decision!=='screen')throw new Fault('screening_policy_unavailable',503)
 if(!c.route.continuation_url)throw new Fault('inbound_continuation_unconfigured',503)
 const challengeId=id(),now=Date.now(),challengeDigit=digit()
 await append(env,c.source.id,'protection.admit',challengeId,'completed',[
  ...fences(env,c),policy.fence,
  env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_protection_rules WHERE id=? AND revoked_at IS NULL AND effect='screen'").bind(v.ruleId),
  env.DB.prepare(`INSERT INTO hnd_protection_challenges
   (id,source_id,source_revision,owner_id,owner_version,account_id,number_id,caller,called_number,call_sid,rule_id,route_revision,digit,attempts,round,status,last_outcome,created_at,expires_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,'pending','screening_started',?,?,?)`).bind(challengeId,c.source.id,c.source.revision,c.source.owner_id,c.source.owner_version,c.source.account_id,c.source.number_id,c.from,c.to,c.callId,v.ruleId,c.route.revision,challengeDigit,now,now+120000,now),
 ],null,applied(c,v.ruleId))
 row=(await byCall(env,c))!
 return gather(env,row)
}
export async function answerChallenge(env:Bindings,c:ChallengeContext,challengeId:string,round:number,digits:string|null):Promise<Response>{
 const row=await env.DB.prepare('SELECT * FROM hnd_protection_challenges WHERE id=?').bind(challengeId).first<Challenge>()
 if(!row)throw new Fault('screening_not_found',404)
 const terminal=await active(env,c,row);if(terminal)return terminal
 if(round!==row.round)throw new Fault('screening_round_consumed',409)
 const policy=await challengePolicy(env,admission(c)),v=policy.verdict
 // Fresh emergency designation and explicit allow exceptions take precedence.
 // Removing a screen rule alone does not turn an old challenge into authority.
 if(v.decision==='exempt'||v.reason==='allow_exception')return continueOnce(env,c,row,policy.fence,v.reason,v.ruleId)
 if(v.decision!=='screen'||v.ruleId!==row.rule_id)return end(env,c,row,'cancelled','screening_policy_changed',policy.fence)
 const attempts=row.attempts+1
 if(digits===row.digit)return continueOnce(env,c,row,policy.fence,'screening_digit_received',v.ruleId,attempts)
 const reason=digits===null||digits===''?'screening_no_digit':'screening_wrong_digit'
 if(attempts>=3)return end(env,c,row,'failed',reason+'_limit',policy.fence,attempts)
 const nextDigit=digit(),nextRound=row.round+1
 await append(env,c.source.id,'protection.admit',row.id,'refused',[
  ...fences(env,c),policy.fence,pendingFence(env,row),
  env.DB.prepare('UPDATE hnd_protection_challenges SET attempts=?,round=?,digit=?,last_outcome=?,updated_at=? WHERE id=?').bind(attempts,nextRound,nextDigit,reason,Date.now(),row.id),
 ],null,applied(c,row.rule_id))
 return gather(env,{...row,attempts,round:nextRound,digit:nextDigit,last_outcome:reason})
}
