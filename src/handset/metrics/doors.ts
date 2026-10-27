import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { escape as e, Fault, integer, json, keys, consolePage as page, text, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import { analyticsCsv } from './native'
import { configForm, reportBody, reportPage } from './pages'
import { configure, configs, currentConfig, datasets, liveReport, saveReport, erasureEpoch, reportFence } from './store'
import { listSchedules, runDueReports, scheduleReport } from './schedules'
import { parseNativeFilters, type NativeFilters } from './filters'
import { groupConflictForm, groupsForm, listGroups, saveGroup } from './groups'
import { dashboardGroups, dashboardMetrics, deleteDashboard, findDashboard, getDashboard, listDashboards, saveDashboard } from './dashboards'
import { dashboardEditor, dashboardList } from './dashboard-pages'
import { denied } from '../audit/store'

function queryFilters(url:URL):NativeFilters {
 const values:Record<string,string>={}
 for(const [key,value] of url.searchParams){
  if(url.searchParams.getAll(key).length!==1)throw new Fault('duplicate_filter')
  if(!['queueId','configRevision'].includes(key))values[key]=value
 }
 return parseNativeFilters(values)
}
function formFilters(value:unknown):NativeFilters {
 if(typeof value!=='string')return parseNativeFilters(value??{})
 try{return parseNativeFilters(JSON.parse(value))}catch(error){if(error instanceof Fault)throw error;throw new Fault('invalid_filters')}
}

export async function metricsDoor(request:Request,env:Bindings,actor:Session,data?:ObjectValue):Promise<Response|null> {
 const url=new URL(request.url),path=url.pathname,html=path.startsWith('/app/'),base=html?'/app/reports/queues':'/api/handset/metrics'
 if(path!==base&&!path.startsWith(base+'/'))return null
 const action=path.slice(base.length),db=env.DB
 if(request.method==='GET'){
  await commit(env,actor,'metrics.read','installation','completed')
  if(!action){
   const rows=await configs(db),schedules=await listSchedules(db),dashboards=await listDashboards(db)
   return html?page('Queue reports',`<p>Review source observations, versioned formulas and scheduled reports. Source events do not themselves certify carrier delivery.</p><p><a href="/app/import">Move in queue dataset</a> · <a href="/app/reports/queues/groups">Reporting groups</a></p><ul>${rows.map(c=>`<li><a href="/app/reports/queues/live?queueId=${encodeURIComponent(c.queueId)}">${e(c.queueId)} · formula ${c.revision}</a></li>`).join('')||'<li>No queues configured.</li>'}</ul>${dashboardList(dashboards)}<h2>Configure a queue interval</h2>${configForm()}<h2>Scheduled reports</h2><ul>${schedules.results.map(s=>`<li>${e(s.queue_id)} · ${e(s.recipient)} · ${e(new Date(s.due_at).toISOString())} · ${e(s.state)}${s.report_id?` · <a href="/app/reports/queues/history/${e(s.report_id)}">Report snapshot</a>`:''}</li>`).join('')||'<li>No scheduled reports.</li>'}</ul><form method="post" action="/app/reports/queues/run"><button>Run due reports</button></form>`):json({configs:rows,schedules:schedules.results,dashboards})
  }
  if(action==='/groups'){
   const groups=await listGroups(db)
   return html?page('Reporting groups',groupsForm(groups)):json({groups})
  }
  if(action==='/dashboards')return html?page('Saved dashboards',dashboardList(await listDashboards(db))):json({dashboards:await listDashboards(db)})
  const dashboardMatch=action.match(/^\/dashboards\/([^/]+)(\/csv)?$/)
  if(dashboardMatch){
   if(url.search)throw new Fault('dashboard_filters_are_saved')
   const dashboard=await getDashboard(db,dashboardMatch[1]),config=await currentConfig(db,dashboard.queueId,dashboard.configRevision),report=await liveReport(env,config,dashboard.filters,dashboard)
   await commit(env,actor,'metrics.read','installation','completed',[reportFence(db,report.erasureEpoch)])
   if(dashboardMatch[2])return csv(report.native)
   return html?reportPage(report,actor.operator.email):json(report)
  }
  if(action==='/datasets'){
   const epoch=await erasureEpoch(db),rows=await datasets(db)
   await commit(env,actor,'metrics.read','installation','completed',[reportFence(db,epoch)])
   return json({datasets:rows})
  }
  if(action==='/live'||action==='/csv'){
   const filters=queryFilters(url),revision=url.searchParams.get('configRevision'),config=await currentConfig(db,text(url.searchParams.get('queueId'),'queueId'),revision===null?undefined:integer(Number(revision),'configRevision',1)),report=await liveReport(env,config,filters)
   await commit(env,actor,'metrics.read','installation','completed',[reportFence(db,report.erasureEpoch)])
   if(action==='/csv')return csv(report.native)
   return html?reportPage(report,actor.operator.email):json(report)
  }
  if(action.startsWith('/history/')){
   const epoch=await erasureEpoch(db),reportId=text(action.slice('/history/'.length),'reportId'),report=await db.prepare('SELECT * FROM hnd_metric_reports WHERE id=?').bind(reportId).first<{id:string;value:string;created_at:number}>()
   if(!report)throw new Fault('report_not_found',404)
   await commit(env,actor,'metrics.read','installation','completed',[reportFence(db,epoch)])
   return html?page('Historical queue report',`<p>Snapshot ${e(report.id)} · ${e(new Date(report.created_at).toISOString())}</p>${reportBody(JSON.parse(report.value))}<a href="/app/reports/queues">All queue reports</a>`):json({id:report.id,...JSON.parse(report.value)})
  }
  throw new Fault('not_found',404)
 }
 if(request.method!=='POST'||!data)throw new Fault('method_not_allowed',405)
 if(html){
  for(const name of ['revision','targetSeconds','shortSeconds','configRevision','repeatWindowHours','dashboardRevision'])if(typeof data[name]==='string')data[name]=Number(data[name])
  for(const name of ['startAt','endAt','dueAt'])if(typeof data[name]==='string')data[name]=Date.parse(data[name]+'Z')
  if(data.excludeShort!==undefined)data.excludeShort=data.excludeShort==='exclude'
 }
 if(action==='/groups'){
  try{
   const result=await saveGroup(env,actor,data)
   return html?redirect('/app/reports/queues/groups'):json(result,201)
  }catch(error){
   if(!html||!(error instanceof Fault)||error.code!=='report_group_changed')throw error
   const draft={number:text(data.number,'number',16),team:text(data.team,'team'),location:text(data.location,'location'),revision:integer(data.revision,'revision')}
   const current=(await listGroups(db)).find(group=>group.number===draft.number)
   await denied(env,actor,'product.request')
   return page('Review assignment draft',`<p role="alert">This assignment was not saved because another session changed it. Your draft is kept below. Compare the current values before saving your reviewed assignment.</p>${groupConflictForm(draft,current)}`,409)
  }
 }
 if(action==='/dashboards'){
  if(html){
   data.groups=dashboardGroups.filter(group=>data['group_'+group]===group);data.metrics=dashboardMetrics.filter(metric=>data['metric_'+metric]===metric)
   for(const key of [...dashboardGroups.map(group=>'group_'+group),...dashboardMetrics.map(metric=>'metric_'+metric)])delete data[key]
   data.filters=formFilters(data.filters)
  }
  try{
   const result=await saveDashboard(env,actor,data)
   return html?redirect('/app/reports/queues/dashboards/'+result.id):json(result,201)
  }catch(error){
   if(!html||!(error instanceof Fault)||![400,409].includes(error.status))throw error
   const config=await currentConfig(db,text(data.queueId,'queueId'),integer(data.configRevision,'configRevision',1)),report=await liveReport(env,config,formFilters(data.filters))
   const current=typeof data.id==='string'?await findDashboard(db,data.id):undefined
   const deleted=typeof data.id==='string'&&!current
   const draft=deleted?{...data,id:undefined,revision:0}:data
   await denied(env,actor,'product.request')
   return page('Review dashboard draft',`<p role="alert">This dashboard was not saved. Your draft is kept below. ${deleted?'The saved dashboard was deleted in another session. Review your draft and save it as a new dashboard to recover your work.':error.status===409?'Someone saved a newer version; compare it before saving your reviewed draft.':'Choose at least one group and measure, and enter a dashboard name.'}</p>${dashboardEditor(report,draft,current,deleted)}<p><a href="/app/reports/queues">All queue reports</a></p>`,error.status)
  }
 }
 const deletion=action.match(/^\/dashboards\/([^/]+)\/delete$/)
 if(deletion){const result=await deleteDashboard(env,actor,deletion[1],data);return html?redirect('/app/reports/queues'):json(result)}
 if(action==='/config'){
  const config=await configure(env,actor,data)
  return html?redirect('/app/reports/queues/live?queueId='+encodeURIComponent(config.queueId)):json(config,201)
 }
 if(action==='/finalize'){
  keys(data,['queueId','configRevision','filters','dashboardId','dashboardRevision']);const config=await currentConfig(db,text(data.queueId,'queueId'),integer(data.configRevision,'configRevision',1))
  const dashboard=data.dashboardId===undefined?undefined:await getDashboard(db,text(data.dashboardId,'dashboardId'))
  if(dashboard&&(dashboard.queueId!==config.queueId||dashboard.configRevision!==config.revision||data.dashboardRevision!==dashboard.revision))throw new Fault('dashboard_changed',409)
  if(!dashboard&&(await currentConfig(db,config.queueId)).revision!==config.revision)throw new Fault('metric_config_changed',409)
  const result=await saveReport(env,actor,config,dashboard?.filters??formFilters(data.filters),dashboard)
  return html?redirect('/app/reports/queues/history/'+result.id):json(result,201)
 }
 if(action==='/schedule'){
  if(html)data.filters=formFilters(data.filters)
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
const csv=(native:Awaited<ReturnType<typeof import('./native').nativeAnalytics>>)=>new Response(analyticsCsv(native),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename=handset-report.csv','cache-control':'no-store'}})
