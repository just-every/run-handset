import { choice, Fault, id, keys, text, type ObjectValue } from '../core'
import { sourceGuard } from './configuration'
import { capacity, reserveCandidate } from './capacity'
import { listEligibility, recipientEligibility } from './eligibility'
import { modes, type Attempt, type Recipient, type Run } from './model'
import { accountBase, ownedFrom, verifyRecipientCall } from './network'
import { safeguard } from './report'
import { attempt, event, guard, list, recipients, run, sql, write, type Context } from './storage'
export async function createSession(ctx:Context,listId:string,v:ObjectValue){
 keys(v,['mode','confirm']);if(v.confirm!=='start exact approved list in this mode')throw new Fault('session_approval_required',403)
 const l=await list(ctx,listId),mode=choice(v.mode,modes,'mode'),eligibility=await listEligibility(ctx,l,mode),target=id(),cursor=(await sql(ctx,'SELECT COALESCE(max(ordinal)+1,0) AS n FROM hnd_dialer_attempts WHERE list_id=?',l.id).first<{n:number}>())!.n
 await write(ctx,target,[...eligibility.fences,guard(ctx,'SELECT CASE WHEN (SELECT COALESCE(max(ordinal)+1,0) FROM hnd_dialer_attempts WHERE list_id=?)=? THEN 1 ELSE 0 END',l.id,cursor),sql(ctx,"UPDATE hnd_dialer_sessions SET state='paused',reason='owner_selected_new_session',revision=revision+1 WHERE list_id=? AND state='running'",l.id),sql(ctx,"INSERT INTO hnd_dialer_sessions(id,list_id,mode,state,reason,cursor,created_by,created_at) VALUES (?,?,?,'running','awaiting explicit launch',?,?,?)",target,l.id,mode,cursor,ctx.actor!.operator.id,Date.now()),event(ctx,'session.started',l.id,target,null,{mode,listHash:l.snapshot_hash})]);return run(ctx,target)
}
export async function pause(ctx:Context,r:Run,reason:string){await write(ctx,r.id,[sql(ctx,"UPDATE hnd_dialer_sessions SET state='paused',reason=?,revision=revision+1 WHERE id=? AND state<>'completed'",reason,r.id),event(ctx,'session.paused',r.list_id,r.id,null,{reason,cursor:r.cursor})]);return run(ctx,r.id)}
export async function sessionAction(ctx:Context,sessionId:string,action:'pause'|'resume',v:ObjectValue){keys(v,[]);const r=await run(ctx,sessionId);if(action==='pause')return pause(ctx,r,'owner_paused');const l=await list(ctx,r.list_id),eligible=await listEligibility(ctx,l,r.mode);if(r.state==='completed')throw new Fault('session_completed',409);await write(ctx,r.id,[...eligible.fences,sql(ctx,"UPDATE hnd_dialer_sessions SET state='running',reason='owner_resumed',revision=revision+1 WHERE id=?",r.id),event(ctx,'session.resumed',l.id,r.id,null,{cursor:r.cursor})]);return run(ctx,r.id)}
async function skip(ctx:Context,r:Run,recipient:Recipient,account:string,from:string,eventKey:string,reason:string){
 const target=id()
 await write(ctx,target,[guard(ctx,"SELECT count(*) FROM hnd_dialer_sessions WHERE id=? AND revision=? AND cursor=? AND state='running'",r.id,r.revision,r.cursor),sql(ctx,"INSERT INTO hnd_dialer_attempts(id,session_id,list_id,ordinal,mode,event_key,state,reason,account_id,from_number,recipient,created_at,ended_at,disposition) VALUES (?,?,?,?,?,?,'held',?,?,?,?,?,?,'suppressed')",target,r.id,r.list_id,recipient.ordinal,r.mode,eventKey,reason,account,from,recipient.recipient,Date.now(),Date.now()),sql(ctx,'UPDATE hnd_dialer_sessions SET cursor=cursor+1,revision=revision+1 WHERE id=?',r.id),event(ctx,'recipient.suppressed',r.list_id,r.id,target,{ordinal:recipient.ordinal,reason})]);return attempt(ctx,target)
}
async function launchOne(ctx:Context,r:Run,recipient:Recipient,eventKey:string){
 if(await sql(ctx,'SELECT id FROM hnd_dialer_attempts WHERE list_id=? AND ordinal=?',r.list_id,recipient.ordinal).first())throw new Fault('recipient_already_attempted',409)
 const l=await list(ctx,r.list_id),eligible=await listEligibility(ctx,l,r.mode)
 let recipientFences:D1PreparedStatement[]
 try{recipientFences=await recipientEligibility(ctx,l,recipient,r.mode,eligible.policy)}catch(error){
  if(error instanceof Fault&&(/dnc|consent_unknown_or_revoked/.test(error.code)))return skip(ctx,r,recipient,eligible.source.account_id,eligible.definition.from,eventKey,error.code)
  throw error
 }
 const stats=await safeguard(ctx,l,eligible.policy,r.mode==='predictive')
 const selected=await reserveCandidate(ctx,l,eligible.source.account_id,eligible.policy)
 await ownedFrom(ctx,eligible.source.account_id,eligible.qualification.number_sid,eligible.definition.from)
 // Recheck consent and time after network readbacks and immediately before the
 // atomic reservation. These are exact target checks, never a caller boolean.
 recipientFences=await recipientEligibility(ctx,l,recipient,r.mode,eligible.policy)
 const target=id(),now=Date.now(),definition=eligible.definition,{agent,ready,slot}=selected
 const callData=JSON.stringify({direction:'outbound',state:'uncertain',from:definition.from,to:recipient.recipient,listId:l.id,listHash:l.snapshot_hash,mode:r.mode,customerOutcome:'unconfirmed'})
 await write(ctx,target,[...eligible.fences,...recipientFences,...selected.fences,sourceGuard(ctx,eligible.source),
  guard(ctx,"SELECT count(*) FROM hnd_dialer_sessions WHERE id=? AND revision=? AND cursor=? AND state='running'",r.id,r.revision,r.cursor),
  guard(ctx,'SELECT count(*) FROM hnd_dialer_lists WHERE id=? AND reserved_cents+?<=json_extract(definition,\'$.budgetCents\')',l.id,definition.attemptCents),
  guard(ctx,"SELECT CASE WHEN (SELECT count(*) FROM hnd_dialer_attempts WHERE list_id=? AND state IN ('uncertain','ringing','active'))<? THEN 1 ELSE 0 END",l.id,Math.min(definition.maxConcurrency,eligible.policy.maxConcurrency)),
  sql(ctx,'INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)',target,'call_session','native','dialer:'+target,now,now,recipient.case_id,recipient.person_id,null,callData,ctx.actor!.operator.id),
  sql(ctx,"INSERT INTO hnd_dialer_attempts(id,session_id,list_id,ordinal,mode,event_key,state,reason,agent_id,account_id,from_number,recipient,conference_sid,conference_name,agent_call_sid,created_at) VALUES (?,?,?,?,?,?,'uncertain','provider_create_uncertain',?,?,?,?,?,?,?,?)",target,r.id,l.id,recipient.ordinal,r.mode,eventKey,agent.operator_id,eligible.source.account_id,definition.from,recipient.recipient,ready.conference_sid,ready.conference_name,ready.agent_call_sid,now),
  sql(ctx,'INSERT INTO hnd_dialer_reservations VALUES (?,?,?,?)',target,agent.operator_id,slot,now),
  sql(ctx,'UPDATE hnd_dialer_lists SET reserved_cents=reserved_cents+? WHERE id=?',definition.attemptCents,l.id),
  sql(ctx,'UPDATE hnd_dialer_sessions SET cursor=cursor+1,revision=revision+1 WHERE id=?',r.id),
  event(ctx,'attempt.persisted_before_provider',l.id,r.id,target,{mode:r.mode,ordinal:recipient.ordinal,budgetReservation:definition.attemptCents,waitingAgent:agent.operator_id,stats}),
 ])
 // No automatic retry. Twilio Calls creation has no application idempotency
 // guarantee; timeout, non-201 and unreadable response retain occupied capacity.
 const base=ctx.env.AUTH_ORIGIN+'/providers/twilio/dialer/'+target
 // Recheck every mutable admission fact after durable intent and before the
 // one network write. A failed recheck is known to have made no paid request.
 try{
  await listEligibility(ctx,await list(ctx,l.id),r.mode)
  await recipientEligibility(ctx,l,recipient,r.mode,eligible.policy,target)
  await capacity(ctx,l,{...eligible.policy,inboundReserve:Math.max(0,eligible.policy.inboundReserve-1)})
 }catch(error){
  if(!(error instanceof Fault))throw error
  await write(ctx,target,[sql(ctx,"UPDATE hnd_dialer_attempts SET state='failed',reason=?,ended_at=?,disposition='not_called',version=version+1 WHERE id=?",error.code,Date.now(),target),sql(ctx,'DELETE FROM hnd_dialer_reservations WHERE attempt_id=?',target),event(ctx,'attempt.admission_changed_no_effect',l.id,r.id,target,{reason:error.code})])
  await pause(ctx,await run(ctx,r.id),error.code)
  return attempt(ctx,target)
 }
 if(ctx.fences)await ctx.env.DB.batch([...ctx.fences(),sql(ctx,'DELETE FROM hnd_guard')])
 const body=new URLSearchParams({To:recipient.recipient,From:definition.from,Url:base+'/answer',Method:'POST',StatusCallback:base+'/status',StatusCallbackMethod:'POST',Timeout:String(eligible.policy.ringSeconds),TimeLimit:String(ctx.maxCallSeconds??3600),Record:'false'})
 for(const item of ['initiated','ringing','answered','completed'])body.append('StatusCallbackEvent',item)
 let response:Response
 try{response=await fetch(accountBase(eligible.source.account_id)+'/Calls.json',{method:'POST',headers:{authorization:'Basic '+btoa(eligible.source.account_id+':'+ctx.env.HANDSET_TWILIO_AUTH_TOKEN),'content-type':'application/x-www-form-urlencoded'},body,redirect:'manual',signal:AbortSignal.timeout(5000)})}catch{return attempt(ctx,target)}
 if(response.status!==201)return attempt(ctx,target)
 let call:Record<string,unknown>;try{call=await response.json()}catch{return attempt(ctx,target)}
 try{verifyRecipientCall(call as never,eligible.source.account_id,definition.from,recipient.recipient,now)}catch{return attempt(ctx,target)}
 if(typeof call.sid!=='string'||!call.sid)return attempt(ctx,target)
 await write(ctx,target,[guard(ctx,'SELECT count(*) FROM hnd_dialer_attempts WHERE id=? AND provider_sid IS NULL',target),sql(ctx,'UPDATE hnd_dialer_attempts SET provider_sid=?,version=version+1 WHERE id=?',call.sid,target),event(ctx,'attempt.create_acknowledged',l.id,r.id,target,{providerSid:call.sid,transport:'acknowledged; readback pending'})])
 return attempt(ctx,target)
}
export async function launch(ctx:Context,sessionId:string,v:ObjectValue){
 keys(v,['eventKey','previewRecipient','confirm']);if(v.confirm!=='launch exact approved recipients now')throw new Fault('launch_approval_required',403)
 const eventKey=text(v.eventKey,'eventKey'),prior=(await sql(ctx,`SELECT * FROM hnd_dialer_attempts WHERE session_id=? AND (event_key=? OR substr(event_key,1,length(?)+1)=?||':') ORDER BY ordinal`,sessionId,eventKey,eventKey,eventKey).all<Attempt>()).results
 if(prior.length)return {attempts:prior,replay:true,externalEffectRepeated:false}
 let r=await run(ctx,sessionId);if(r.state!=='running')throw new Fault('session_not_running',409)
 const l=await list(ctx,r.list_id),rows=await recipients(ctx,l.id),eligible=await listEligibility(ctx,l,r.mode)
 if(r.mode==='preview'&&v.previewRecipient!==rows[r.cursor]?.recipient)throw new Fault('preview_exact_recipient_required',409)
 let count=1
 try{
  const c=await capacity(ctx,l,eligible.policy),stats=await safeguard(ctx,l,eligible.policy,r.mode==='predictive'),limit=Math.min(eligible.definition.maxConcurrency,eligible.policy.maxConcurrency,c.available,c.candidates.length)
  if(r.mode==='power'||r.mode==='parallel')count=limit
  if(r.mode==='predictive')count=Math.min(limit,Math.max(1,Math.floor(c.available*(stats.answerRate??0))))
  if(count<1)throw new Fault('waiting_agent_required',409)
 }catch(error){if(error instanceof Fault){await pause(ctx,r,error.code);return {session:await run(ctx,r.id),attempts:[],held:error.code}}throw error}
 const attempts:Attempt[]=[]
 for(let i=0;i<count;i++){
  r=await run(ctx,r.id);if(r.state!=='running'||r.cursor>=rows.length)break
  try{attempts.push(await launchOne(ctx,r,rows[r.cursor],eventKey+':'+i))}catch(error){if(error instanceof Fault){await pause(ctx,r,error.code);return {attempts,session:await run(ctx,r.id),held:error.code}}throw error}
 }
 r=await run(ctx,r.id)
 if(r.state==='running'&&r.cursor>=rows.length){await write(ctx,r.id,[sql(ctx,"UPDATE hnd_dialer_sessions SET state='completed',reason='list exhausted; pending calls retained',revision=revision+1 WHERE id=?",r.id),event(ctx,'session.exhausted',l.id,r.id,null,{cursor:r.cursor})])}
 return {attempts,session:await run(ctx,r.id),replay:false}
}
