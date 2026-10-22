import { Fault, id, keys, text, type ObjectValue } from '../core'
import { language } from './model'
import { routeReady } from './media-policy'
import { event, guard, queue, statement, write, type OwnerContext } from './storage'

export interface QueueBinding {id:string;source_id:string;queue_id:string;language:string;spanish_digit:string;owner_id:string;owner_version:number;created_at:number;revoked_at:number|null}
export async function bindSource(ctx:OwnerContext,value:ObjectValue){
 keys(value,['sourceId','queueId','language','spanishDigit','confirm'])
 if(value.confirm!=='authorize signed inbound queue routing')throw new Fault('queue_source_consent_required',403)
 if(!ctx.env.HANDSET_TWILIO_AUTH_TOKEN)throw new Fault('twilio_secret_binding_required',409)
 const sourceId=text(value.sourceId,'sourceId'),q=await queue(ctx,text(value.queueId,'queueId')),lang=language(value.language??'en'),digit=text(value.spanishDigit??'2','spanishDigit',1)
 if(!/^[0-9]$/.test(digit))throw new Fault('invalid_spanish_digit')
 await routeReady(ctx,q.id)
 const target=id()
 await write(ctx,target,[guard(ctx,`SELECT count(*) FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id WHERE s.id=? AND s.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=s.owner_version`,sourceId),
  statement(ctx,'INSERT INTO hnd_queue_bindings VALUES (?,?,?,?,?,?,?,?,NULL)',target,sourceId,q.id,lang,digit,ctx.actor.operator.id,ctx.actor.operator.version,Date.now()),
  event(ctx,'source.authorized',q.id,null,null,{bindingId:target}),
 ])
 return {id:target,callbackPath:'/providers/twilio/queues/'+target,scope:'Signed inbound routing only. No agent dialing or qualified voicemail/receptionist delivery.'}
}
export async function revokeBinding(ctx:OwnerContext,bindingId:string){
 const row=await statement(ctx,'SELECT * FROM hnd_queue_bindings WHERE id=?',bindingId).first<QueueBinding>()
 if(!row)throw new Fault('queue_binding_not_found',404)
 await write(ctx,row.id,[statement(ctx,'UPDATE hnd_queue_bindings SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',Date.now(),row.id),event(ctx,'source.revoked',row.queue_id,null,null,{bindingId:row.id})])
 return {revoked:true}
}
