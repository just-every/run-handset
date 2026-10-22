import { escape as e, Fault } from '../core'
import { enqueue, entryAction, overflow } from './entries'
import { announcement } from './read'
import { dispatch, reconcile } from './routing'
import { entry, event, queue, statement, write, type Context } from './storage'
import { sourceCall, type BoundSource } from './provider-proof'
import { callTerminal, readCall } from './provider-api'
import { currentOffer, emitOffer } from './offers'
import { recoverOffer } from './offer-readback'
import { overflowInstructions, routeReady, unavailableEnding } from './overflow-response'
import type { Entry } from './model'

export async function voiceInstructions(ctx:Context,source:BoundSource,p:URLSearchParams){
 const callId=await sourceCall(ctx,source,p)
 let row=await statement(ctx,'SELECT * FROM hnd_queue_entries WHERE call_id=?',callId).first<Entry>()
 const parentSid=p.get('CallSid')!,parent=await readCall(ctx,source.account_id,parentSid)
 if(parent.direction!=='inbound'||parent.from!==p.get('From')||parent.to!==p.get('To'))throw new Fault('queue_parent_identity_mismatch',502)
 if(row&&row.origin_queue_id!==source.queue_id)throw new Fault('queue_call_binding_scope_mismatch',403)
 if(callTerminal(parent.status)){
  if(row){
   const offer=await currentOffer(ctx,row)
   if(offer&&['uncertain','ringing','active'].includes(offer.state))await recoverOffer(ctx,offer)
   else if(['waiting','reserved','active'].includes(row.state))await entryAction(ctx,row.id,'abandon',{revision:row.revision})
  }
  return '<Hangup/>'
 }
 if(!row)row=(await enqueue(ctx,source.queue_id,{callId,language:p.get('Digits')===source.spanish_digit?'es':source.language,skills:[],priority:0})).entry
 return continueVoice(ctx,source,row,parentSid)
}
export async function continueVoice(ctx:Context,source:BoundSource,initial:Entry,parentSid:string):Promise<string>{
 let row=await entry(ctx,initial.id)
 if(['waiting','reserved'].includes(row.state)&&!await currentOffer(ctx,row)){
  try{await routeReady(ctx,row.queue_id)}catch(error){
   if(!(error instanceof Fault)||error.code!=='queue_overflow_route_unqualified')throw error
   await write(ctx,row.id,[
    statement(ctx,'DELETE FROM hnd_queue_reservations WHERE entry_id=?',row.id),
    statement(ctx,"UPDATE hnd_queue_entries SET state='overflow',overflow_kind='native',reason='overflow_route_unavailable',agent_id=NULL,ended_at=?,revision=revision+1 WHERE id=? AND revision=?",Date.now(),row.id,row.revision),
   ])
   return unavailableEnding(ctx,await entry(ctx,row.id),'overflow_route_unavailable')
  }
 }
 if(['waiting','reserved'].includes(row.state)){
  await reconcile(ctx,row.queue_id);row=await entry(ctx,row.id)
  if(row.state==='waiting'){await dispatch(ctx,row.queue_id);row=await entry(ctx,row.id)}
 }
 if(row.state==='overflow')return overflowInstructions(ctx,row)
 if(['completed','abandoned'].includes(row.state))return '<Hangup/>'
 const offer=await currentOffer(ctx,row)
 if(offer){
  const observed=await recoverOffer(ctx,offer);row=await entry(ctx,row.id)
  if(row.state==='overflow')return overflowInstructions(ctx,row)
  if(['completed','abandoned'].includes(row.state))return '<Hangup/>'
  if(row.state==='waiting')return continueVoice(ctx,source,row,parentSid)
  // Never replay Dial, even if no child is yet visible after a lost response.
  // A current active Dial must retain control; returning another Dial or an
  // overflow here would risk duplicate legs or disconnect an active caller.
  if(observed.offer.state==='active')throw new Fault('queue_call_already_bridged',409,{offerId:offer.id})
  if(row.deadline_at<=Date.now())throw new Fault('queue_offer_outcome_uncertain',409,{offerId:offer.id})
  return waitingInstructions(ctx,source,row)
 }
 const prepared=await announcement(ctx,row)
 if(row.state==='reserved'){
  try{const prompt=await say(ctx,prepared,row);return prompt+await emitOffer(ctx,source,row,parentSid)}
  catch(error){
   if(error instanceof Fault&&error.code==='queue_dial_deadline_too_close'){
    await overflow(ctx,row,await queue(ctx,row.queue_id),'maximum_wait');return continueVoice(ctx,source,await entry(ctx,row.id),parentSid)
   }
   throw error
  }
 }
 return waitingInstructions(ctx,source,row,prepared)
}
async function say(ctx:Context,prepared:Record<string,unknown>|null,row:Entry){
 if(!prepared)return ''
 await write(ctx,row.id,[event(ctx,'announcement.instructions',row.queue_id,row.id,row.agent_id,{announcementId:prepared.id,position:prepared.position,estimatedWaitSeconds:prepared.estimated_wait_seconds,samples:prepared.estimate_samples,transport:'instructions_emitted',audioReceipt:'unknown'})])
 return `<Say language="${row.language.startsWith('es')?'es-MX':'en-US'}">${e(prepared.text)}</Say>`
}
async function waitingInstructions(ctx:Context,source:BoundSource,row:Entry,prepared?:Record<string,unknown>|null){
 const prompt=prepared===undefined?await announcement(ctx,row):prepared
 return `${await say(ctx,prompt,row)}<Pause length="1"/><Redirect method="POST">${e(ctx.env.AUTH_ORIGIN+'/providers/twilio/queues/'+source.id)}</Redirect>`
}
