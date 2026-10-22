import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { escape as e, Fault, integer, json, keys, consolePage as page, text, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import { configForm, reportBody, reportPage } from './pages'
import { configure, configs, currentConfig, datasets, liveReport, saveReport } from './store'
import { listSchedules, runDueReports, scheduleReport } from './schedules'

export async function metricsDoor(request:Request,env:Bindings,actor:Session,data?:ObjectValue):Promise<Response|null> {
 const url=new URL(request.url),path=url.pathname,html=path.startsWith('/app/'),base=html?'/app/reports/queues':'/api/handset/metrics'
 if(path!==base&&!path.startsWith(base+'/'))return null
 const action=path.slice(base.length),db=env.DB
 if(request.method==='GET'){
  await commit(env,actor,'metrics.read','installation','completed')
  if(!action){
   const rows=await configs(db),schedules=await listSchedules(db)
   return html?page('Queue reports',`<p>Review source observations, versioned formulas and scheduled reports. Source events do not themselves certify carrier delivery.</p><p><a href="/app/import">Move in queue dataset</a></p><ul>${rows.map(c=>`<li><a href="/app/reports/queues/live?queueId=${encodeURIComponent(c.queueId)}">${e(c.queueId)} · formula ${c.revision}</a></li>`).join('')||'<li>No queues configured.</li>'}</ul><h2>Configure a queue interval</h2>${configForm()}<h2>Scheduled reports</h2><ul>${schedules.results.map(s=>`<li>${e(s.queue_id)} · ${e(s.recipient)} · ${e(new Date(s.due_at).toISOString())} · ${e(s.state)}${s.report_id?` · <a href="/app/reports/queues/history/${e(s.report_id)}">Report snapshot</a>`:''}</li>`).join('')||'<li>No scheduled reports.</li>'}</ul><form method="post" action="/app/reports/queues/run"><button>Run due reports</button></form>`):json({configs:rows,schedules:schedules.results})
  }
  if(action==='/datasets')return json({datasets:await datasets(db)})
  if(action==='/live'){
   const config=await currentConfig(db,text(url.searchParams.get('queueId'),'queueId')),report=await liveReport(env,config)
   return html?reportPage(report,actor.operator.email):json(report)
  }
  if(action.startsWith('/history/')){
   const reportId=text(action.slice('/history/'.length),'reportId'),report=await db.prepare('SELECT * FROM hnd_metric_reports WHERE id=?').bind(reportId).first<{id:string;value:string;created_at:number}>()
   if(!report)throw new Fault('report_not_found',404)
   return html?page('Historical queue report',`<p>Snapshot ${e(report.id)} · ${e(new Date(report.created_at).toISOString())}</p>${reportBody(JSON.parse(report.value))}<a href="/app/reports/queues">All queue reports</a>`):json({id:report.id,...JSON.parse(report.value)})
  }
  throw new Fault('not_found',404)
 }
 if(request.method!=='POST'||!data)throw new Fault('method_not_allowed',405)
 if(html){
  for(const name of ['revision','targetSeconds','shortSeconds','configRevision'])if(typeof data[name]==='string')data[name]=Number(data[name])
  for(const name of ['startAt','endAt','dueAt'])if(typeof data[name]==='string')data[name]=Date.parse(data[name]+'Z')
  if(data.excludeShort!==undefined)data.excludeShort=data.excludeShort==='exclude'
 }
 if(action==='/config'){
  const config=await configure(env,actor,data)
  return html?redirect('/app/reports/queues/live?queueId='+encodeURIComponent(config.queueId)):json(config,201)
 }
 if(action==='/finalize'){
  keys(data,['queueId','configRevision']);const config=await currentConfig(db,text(data.queueId,'queueId'))
  if(config.revision!==integer(data.configRevision,'configRevision',1))throw new Fault('metric_config_changed',409)
  const result=await saveReport(env,actor,config)
  return html?redirect('/app/reports/queues/history/'+result.id):json(result,201)
 }
 if(action==='/schedule'){
  const result=await scheduleReport(env,actor,data)
  return html?redirect('/app/reports/queues'):json(result,201)
 }
 if(action==='/run'){
  keys(data,[]);const result=await runDueReports(env)
  return html?redirect('/app/reports/queues'):json({results:result})
 }
 throw new Fault('not_found',404)
}
const redirect=(location:string)=>new Response(null,{status:303,headers:{location,'cache-control':'no-store'}})
