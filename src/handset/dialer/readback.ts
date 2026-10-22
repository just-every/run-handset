import { choice, Fault, id, keys, text, type ObjectValue } from '../core'
import { readCall, callTerminal } from '../queues/provider-api'
import { providerGet, verifyRecipientCall } from './network'
import { attempt, event, guard, list, qualification, sql, write, type Context } from './storage'
import type { Attempt, QualificationDefinition } from './model'
export async function reconcileAttempt(ctx:Context,original:Attempt,signedSid?:string){
 let row=await attempt(ctx,original.id)
 const sid=row.provider_sid??signedSid
 if(!sid)return {attempt:row,held:'awaiting_signed_callback_after_uncertain_create'}
 if(row.provider_sid&&signedSid&&row.provider_sid!==signedSid)throw new Fault('dialer_provider_sid_conflict',409)
 const l=await list(ctx,row.list_id),q=await qualification(ctx,l.qualification_id),p=JSON.parse(q.definition) as QualificationDefinition
 const call=await readCall(ctx,row.account_id,sid);verifyRecipientCall(call,row.account_id,row.from_number,row.recipient,row.created_at)
 const now=Date.now(),ended=callTerminal(call.status),start=call.start_time?Date.parse(call.start_time):null,end=call.end_time?Date.parse(call.end_time):null
 if(start!==null&&!Number.isFinite(start)||end!==null&&!Number.isFinite(end))throw new Fault('dialer_call_timing_unavailable',503)
 let bridge=row.bridge_observed_at
 if(row.bridge_emitted_at&&row.conference_sid&&!ended){
  const participants=await providerGet(ctx,row.account_id,'/Conferences/'+encodeURIComponent(row.conference_sid)+'/Participants.json?PageSize=100')
  if(!Array.isArray(participants.participants)||participants.next_page_uri)throw new Fault('dialer_participants_unavailable',503)
  const peer=participants.participants.find(v=>v.account_sid===row.account_id&&v.conference_sid===row.conference_sid&&v.call_sid===sid&&v.status==='connected'&&v.muted===false&&v.hold===false),agent=participants.participants.find(v=>v.account_sid===row.account_id&&v.conference_sid===row.conference_sid&&v.call_sid===row.agent_call_sid&&v.status==='connected'&&v.muted===false&&v.hold===false&&v.coaching!==true)
  if(peer&&agent){const joined=Date.parse(String(peer.date_created));if(Number.isFinite(joined)&&joined>=row.created_at-1000&&joined<=now)bridge=joined}
 }
 const answer=row.answer_at??start,late=answer!==null&&bridge!==null&&bridge-answer>p.maxConnectMs
 const reason=late?'connect_deadline_breach':ended&&answer!==null&&bridge===null?'connection_unproven':ended?'provider_terminal':call.status==='in-progress'?'recipient_answered_waiting_bridge_observation':'provider_'+call.status
 const next=ended?(call.status==='completed'?'completed':'failed'):bridge!==null?'active':'ringing'
 if(row.provider_sid===sid&&row.state===next&&row.answer_at===answer&&row.bridge_observed_at===bridge&&row.reason===reason)return {attempt:row,replay:true}
 // A call's immutable source records retain remote status and timing. They do
 // not claim a human conversation, audio delivery or a successful business result.
 const recordId=id(),recipient=await sql(ctx,'SELECT case_id FROM hnd_dialer_recipients WHERE list_id=? AND ordinal=?',l.id,row.ordinal).first<{case_id:string}>()
 const statements=[guard(ctx,'SELECT count(*) FROM hnd_dialer_attempts WHERE id=? AND version=?',row.id,row.version),
  sql(ctx,'UPDATE hnd_dialer_attempts SET provider_sid=?,state=?,reason=?,observed_at=?,answer_at=?,ended_at=?,bridge_observed_at=?,version=version+1 WHERE id=?',sid,next,reason,now,answer,ended?end??now:null,bridge,row.id),
  sql(ctx,'INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)',recordId,'call_leg','native','dialer:'+row.id+':'+(row.version+1),start??row.created_at,now,recipient!.case_id,row.id,null,JSON.stringify({providerStatus:call.status,providerSid:sid,from:row.from_number,to:row.recipient,answerAt:answer,bridgeObservedAt:bridge,customerOutcome:'unconfirmed',observation:'official Calls and Conference Participants readback'}),ctx.actor?.operator.id??ctx.auditActor!),
  sql(ctx,'INSERT INTO hnd_record_sources VALUES (?,?,?,?)',recordId,l.source_id,'twilio','dialer:'+row.id+':'+(row.version+1)),
  event(ctx,'attempt.provider_observed',l.id,row.session_id,row.id,{providerSid:sid,providerStatus:call.status,answerAt:answer,bridgeObservedAt:bridge,reason}),
 ]
 if(ended)statements.push(sql(ctx,'DELETE FROM hnd_dialer_reservations WHERE attempt_id=?',row.id),sql(ctx,'DELETE FROM hnd_dialer_ready WHERE agent_id=? AND agent_call_sid=?',row.agent_id,row.agent_call_sid),sql(ctx,'UPDATE hnd_queue_agents SET wrap_until=max(wrap_until,?+(SELECT wrap_seconds*1000 FROM hnd_queues WHERE id=?)),idle_since=?,revision=revision+1 WHERE operator_id=?',now,l.queue_id,now,row.agent_id))
 if(late||reason==='connection_unproven')statements.push(sql(ctx,"UPDATE hnd_dialer_sessions SET state='paused',reason=?,revision=revision+1 WHERE list_id=? AND state='running'",reason,l.id))
 await write(ctx,row.id,statements)
 row=await attempt(ctx,row.id);return {attempt:row,replay:false}
}
export async function disposition(ctx:Context,attemptId:string,v:ObjectValue){
 keys(v,['outcome','notes','confirm']);if(v.confirm!=='record observed call disposition')throw new Fault('disposition_confirmation_required',403)
 const row=await attempt(ctx,attemptId),outcome=choice(v.outcome,['human_connected','answering_machine','unanswered','abandoned','unknown'],'outcome'),notes=text(v.notes,'notes',4000)
 if(!row.ended_at||row.state==='held')throw new Fault('provider_terminal_readback_required',409)
 if(row.disposition)throw new Fault('disposition_already_recorded',409)
 if(outcome==='human_connected'&&(!row.answer_at||!row.bridge_observed_at)||outcome==='unanswered'&&row.answer_at||outcome==='answering_machine'&&!row.answer_at)throw new Fault('disposition_conflicts_with_transport',409)
 const l=await list(ctx,row.list_id),recipient=await sql(ctx,'SELECT case_id FROM hnd_dialer_recipients WHERE list_id=? AND ordinal=?',l.id,row.ordinal).first<{case_id:string}>(),target=id()
 await write(ctx,row.id,[guard(ctx,"SELECT count(*) FROM hnd_dialer_attempts WHERE id=? AND version=? AND disposition=''",row.id,row.version),sql(ctx,'UPDATE hnd_dialer_attempts SET disposition=?,version=version+1 WHERE id=?',outcome,row.id),sql(ctx,'INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)',target,'disposition','native','dialer:'+row.id+':disposition',Date.now(),Date.now(),recipient!.case_id,row.id,null,JSON.stringify({text:notes,outcome,mode:row.mode,listId:l.id,attemptId:row.id,customerOutcome:'human recorded; not independently certified'}),ctx.actor!.operator.id),event(ctx,'attempt.disposition',l.id,row.session_id,row.id,{outcome,recordId:target})]);return attempt(ctx,row.id)
}
