import type { Bindings } from '../../auth.server'
import type { Session, MailMessage } from '../../modules/operator-auth/index.mjs'
import { operatorMail } from '../../mail.server.mjs'
import { actorRef, append } from '../audit/store'
import { Fault, id, integer, owner, text, escape, type ObjectValue } from '../core'
import { guard, sql } from '../delegation/store'
import { callRows, callCsv, counts } from './logs'
import { event, filters, hash, type Filters } from './model'

export interface Schedule {id:string;owner_id:string;owner_version:number;filters:string;recipient:string;due_at:number;email_copy_policy:string;created_at:number;state:string;call_count:number|null;leg_count:number|null;csv_hash:string|null}
export const emailCopyPolicy='I approve sensitive call-log CSV copies to this exact recipient in separate email custody'
export async function schedule(env:Bindings,actor:Session,v:ObjectValue){
 owner(actor)
 if(v.confirm!=='schedule this exact call-log email'||v.emailCopyPolicy!==emailCopyPolicy)throw new Fault('explicit_sensitive_email_copy_approval_required',403)
 const f=filters(v),recipient=text(v.recipient,'recipient',254),due=integer(Number(v.dueAt),'dueAt',Date.now()-60000,Date.now()+31*86400000),target=id()
 if(!f.queueId&&!f.ownerId)throw new Fault('queue_or_owner_scope_required')
 if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient))throw new Fault('invalid_recipient')
 if(f.queueId&&!await sql(env,'SELECT id FROM hnd_queues WHERE id=?',f.queueId).first())throw new Fault('export_queue_not_found',404)
 if(f.ownerId&&!await sql(env,"SELECT id FROM oa_operators WHERE id=? AND status='active'",f.ownerId).first())throw new Fault('export_owner_not_found',404)
 if(!operatorMail(env)||!env.MAIL_FROM)throw new Fault('mail_transport_required',409)
 await event(env,actor,'exports.schedule',target,[sql(env,`INSERT INTO hnd_export_schedules(id,owner_id,owner_version,filters,recipient,due_at,email_copy_policy,created_at,state) VALUES (?,?,?,?,?,?,?,?,'scheduled')`,target,actor.operator.id,actor.operator.version,JSON.stringify(f),recipient,due,emailCopyPolicy,Date.now())])
 return (await sql(env,'SELECT * FROM hnd_export_schedules WHERE id=?',target).first<Schedule>())!
}
const ownerFence=(env:Bindings,s:Schedule,state:string)=>guard(env,`SELECT count(*) FROM hnd_export_schedules s JOIN oa_operators o ON o.id=s.owner_id WHERE s.id=? AND s.state=? AND o.role='owner' AND o.status='active' AND o.version=s.owner_version AND s.email_copy_policy=?`,s.id,state,emailCopyPolicy)
export async function tickExports(env:Bindings,now=Date.now()){
 const rows=(await sql(env,"SELECT * FROM hnd_export_schedules WHERE state='scheduled' AND due_at<=? ORDER BY due_at,id LIMIT 20",now).all<Schedule>()).results,results=[]
 for(const s of rows){
  const pseudonym=await actorRef(env.DB,s.owner_id)
  if(!await sql(env,"SELECT id FROM oa_operators WHERE id=? AND version=? AND role='owner' AND status='active'",s.owner_id,s.owner_version).first()){
   await append(env,pseudonym,'exports.deliver',s.id,'refused',[sql(env,"UPDATE hnd_export_schedules SET state='refused' WHERE id=? AND state='scheduled'",s.id)]);results.push({id:s.id,state:'refused'});continue
  }
  const f=JSON.parse(s.filters) as Filters,records=await callRows(env,f,now),csv=callCsv(records,f),bytes=new TextEncoder().encode(csv),summary=counts(records)
  if(bytes.length>8_000_000){await append(env,pseudonym,'exports.deliver',s.id,'failed',[sql(env,"UPDATE hnd_export_schedules SET state='failed' WHERE id=? AND state='scheduled'",s.id)]);results.push({id:s.id,state:'failed',reason:'email_attachment_size_unqualified'});continue}
  try{await append(env,pseudonym,'exports.deliver',s.id,'uncertain',[ownerFence(env,s,'scheduled'),sql(env,"UPDATE hnd_export_schedules SET state='sending',call_count=?,leg_count=?,csv_hash=? WHERE id=?",summary.callCount,summary.legCount,await hash(bytes),s.id)])}catch(error){if(error instanceof Fault&&error.code==='state_changed')continue;throw error}
  let state='uncertain'
  try{
   await env.DB.batch([ownerFence(env,s,'sending'),sql(env,'DELETE FROM hnd_guard')])
   const sender=operatorMail(env)
   if(!sender||!env.MAIL_FROM)state='failed'
   else{
    const body=`Call-log CSV for ${new Date(f.from).toISOString()} through ${new Date(f.to).toISOString()} (exclusive). Timezone: ${f.timezone}. Recipient: ${s.recipient}. Calls: ${summary.callCount}. Legs: ${summary.legCount}. Export: ${s.id}. Separate email copies cannot be recalled by revoking this schedule.`,message:MailMessage & {attachments:{filename:string;contentType:string;content:Uint8Array}[]}={deliveryId:s.id,from:env.MAIL_FROM,to:[s.recipient],subject:'Handset call-log CSV · '+f.timezone,text:body,html:'<p>'+escape(body)+'</p>',headers:{},attachments:[{filename:'handset-call-log-'+s.id+'.csv',contentType:'text/csv',content:bytes}]}
    const result=await sender.send(message);state=result.status==='accepted'?'accepted':result.status==='development'?'development':result.status==='uncertain'?'uncertain':'failed'
   }
  }catch(error){state=error instanceof Error&&error.name==='MailValidationError'?'failed':'uncertain'}
  await append(env,pseudonym,'exports.deliver',s.id,state==='accepted'||state==='development'?'completed':state==='uncertain'?'uncertain':'failed',[sql(env,"UPDATE hnd_export_schedules SET state=? WHERE id=? AND state='sending'",state,s.id)])
  results.push({id:s.id,state})
 }
 return results
}
