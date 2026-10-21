import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { operatorMail } from '../../mail.server.mjs'
import { actorRef, append, commit } from '../audit/store'
import { escape, Fault, id, keys, object, text, timestamp } from '../core'
import { currentConfig, liveReport } from './store'

interface Schedule {id:string;queue_id:string;config_revision:number;owner_id:string;owner_version:number;recipient:string;due_at:number;created_at:number;state:string;report_id:string|null}
export async function scheduleReport(env:Bindings,actor:Session,value:unknown) {
 const v=object(value);keys(v,['queueId','configRevision','dueAt','recipient','confirm'])
 if(v.confirm!=='schedule this owner report')throw new Fault('explicit_schedule_consent_required')
 const recipient=text(v.recipient,'recipient',254)
 if(recipient!==actor.operator.email||recipient!==env.OWNER_EMAIL)throw new Fault('owner_recipient_required',403)
 if(!env.MAIL_FROM||!operatorMail(env))throw new Fault('mail_transport_required',409)
 const dueAt=timestamp(v.dueAt,'dueAt')
 if(dueAt>Date.now()+31*86400000||dueAt<Date.now()-60000)throw new Fault('due_within_31_days_required')
 const config=await currentConfig(env.DB,text(v.queueId,'queueId'))
 if(v.configRevision!==config.revision)throw new Fault('metric_config_changed',409)
 const scheduleId=id()
 await commit(env,actor,'metrics.schedule',scheduleId,'completed',[env.DB.prepare('INSERT INTO hnd_metric_schedules VALUES (?,?,?,?,?,?,?,?,?,NULL)').bind(scheduleId,config.queueId,config.revision,actor.operator.id,actor.operator.version,recipient,dueAt,Date.now(),'scheduled')])
 return env.DB.prepare('SELECT * FROM hnd_metric_schedules WHERE id=?').bind(scheduleId).first<Schedule>()
}
export const listSchedules=(db:D1Database)=>db.prepare('SELECT * FROM hnd_metric_schedules ORDER BY created_at DESC LIMIT 100').all<Schedule>()
export async function runDueReports(env:Bindings,now=Date.now()) {
 const rows=(await env.DB.prepare("SELECT * FROM hnd_metric_schedules WHERE state='scheduled' AND due_at<=? ORDER BY due_at LIMIT 20").bind(now).all<Schedule>()).results
 const results:{id:string;state:string}[]=[]
 for(const job of rows){
  const db=env.DB,pseudonym=await actorRef(db,job.owner_id)
  const owner=await db.prepare("SELECT id FROM oa_operators WHERE id=? AND role='owner' AND status='active' AND version=? AND email=?").bind(job.owner_id,job.owner_version,job.recipient).first()
  if(!owner||job.recipient!==env.OWNER_EMAIL){await append(env,pseudonym,'metrics.deliver',job.id,'refused',[db.prepare("UPDATE hnd_metric_schedules SET state='refused' WHERE id=? AND state='scheduled'").bind(job.id)]);results.push({id:job.id,state:'refused'});continue}
  const config=await currentConfig(db,job.queue_id,job.config_revision),report=await liveReport(env,config),reportId=id()
  try{await append(env,pseudonym,'metrics.deliver',job.id,'completed',[
   db.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_metric_schedules s JOIN oa_operators o ON o.id=s.owner_id WHERE s.id=? AND s.state='scheduled' AND s.owner_version=o.version AND o.role='owner' AND o.status='active' AND o.email=s.recipient").bind(job.id),
   db.prepare('INSERT INTO hnd_metric_reports VALUES (?,?,?,?,?,?)').bind(reportId,config.queueId,config.revision,report.sourceHash,JSON.stringify(report),now),
   db.prepare("UPDATE hnd_metric_schedules SET state='sending',report_id=? WHERE id=? AND state='scheduled'").bind(reportId,job.id),
  ])}catch(error){if(error instanceof Fault&&error.code==='state_changed')continue;throw error}
  // Claim before the network edge. A lost acknowledgement remains uncertain;
  // neither a restart nor a cron replay sends the same job a second time.
  let state='uncertain'
  try{
   const sender=operatorMail(env)
   if(!sender||!env.MAIL_FROM)state='failed'
   else {const body=JSON.stringify({reportId,...report},null,2),sent=await sender.send({deliveryId:job.id,from:env.MAIL_FROM,to:[job.recipient],subject:`Handset queue report: ${config.queueId}`,text:body,html:`<pre>${escape(body)}</pre>`,headers:{}});state=sent.status==='accepted'?'accepted':sent.status==='development'?'development':sent.status==='uncertain'?'uncertain':'failed'}
  }catch(error){state=error instanceof Error&&error.name==='MailValidationError'?'failed':'uncertain'}
  await append(env,pseudonym,'metrics.deliver',job.id,state==='accepted'||state==='development'?'completed':state==='uncertain'?'uncertain':'failed',[db.prepare("UPDATE hnd_metric_schedules SET state=? WHERE id=? AND state='sending'").bind(state,job.id)])
  results.push({id:job.id,state})
 }
 return results
}
