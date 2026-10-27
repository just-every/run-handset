import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { choice, Fault, id, integer, keys, object, owner, text } from '../core'
import { parseNativeFilters, type NativeFilters } from './filters'
import { currentConfig } from './store'

export const dashboardGroups = ['hour','person','number','team','location'] as const
export const dashboardMetrics = ['volume','answered','missed'] as const
export interface Dashboard {
 id:string; revision:number; name:string; queueId:string; configRevision:number
 filters:NativeFilters; groups:(typeof dashboardGroups[number])[]; metrics:(typeof dashboardMetrics[number])[]
}
export const dashboardFence=(db:D1Database,dashboard:Dashboard)=>db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_metric_dashboards WHERE id=? AND revision=?').bind(dashboard.id,dashboard.revision)
function selection<T extends string>(value:unknown,allowed:readonly T[],name:string):T[] {
 if(!Array.isArray(value)||!value.length||value.length>allowed.length)throw new Fault('invalid_'+name)
 const result=value.map(v=>choice(v,allowed,name))
 if(new Set(result).size!==result.length)throw new Fault('duplicate_'+name)
 return result
}
export async function listDashboards(db:D1Database):Promise<Dashboard[]> {
 return (await db.prepare('SELECT value FROM hnd_metric_dashboards ORDER BY updated_at DESC,id').all<{value:string}>()).results.map(row=>JSON.parse(row.value))
}
export async function findDashboard(db:D1Database,dashboardId:string):Promise<Dashboard|undefined> {
 const row=await db.prepare('SELECT value FROM hnd_metric_dashboards WHERE id=?').bind(dashboardId).first<{value:string}>()
 return row?JSON.parse(row.value):undefined
}
export async function getDashboard(db:D1Database,dashboardId:string):Promise<Dashboard> {
 const dashboard=await findDashboard(db,dashboardId)
 if(!dashboard)throw new Fault('dashboard_not_found',404)
 return dashboard
}
export async function saveDashboard(env:Bindings,actor:Session,value:unknown) {
 owner(actor)
 const v=object(value);keys(v,['id','revision','name','queueId','configRevision','filters','groups','metrics'])
 const revision=integer(v.revision??0,'revision'),dashboardId=v.id===undefined?id():text(v.id,'dashboardId')
 const queueId=text(v.queueId,'queueId'),configRevision=integer(v.configRevision,'configRevision',1)
 await currentConfig(env.DB,queueId,configRevision)
 const dashboard:Dashboard={id:dashboardId,revision:revision+1,name:text(v.name,'dashboardName',100),queueId,configRevision,filters:parseNativeFilters(v.filters??{}),groups:selection(v.groups,dashboardGroups,'groups'),metrics:selection(v.metrics,dashboardMetrics,'metrics')}
 const db=env.DB
 const existing=await db.prepare('SELECT revision FROM hnd_metric_dashboards WHERE id=?').bind(dashboardId).first<{revision:number}>()
 if((existing?.revision??0)!==revision)throw new Fault('dashboard_changed',409)
 await commit(env,actor,'metrics.configure',dashboardId,'completed',[
  db.prepare('INSERT INTO hnd_guard(ok) SELECT COALESCE((SELECT revision FROM hnd_metric_dashboards WHERE id=?),0)=?').bind(dashboardId,revision),
  db.prepare('INSERT INTO hnd_metric_dashboards VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at').bind(dashboardId,dashboard.revision,JSON.stringify(dashboard),actor.operator.id,Date.now()),
 ])
 return dashboard
}
export async function deleteDashboard(env:Bindings,actor:Session,dashboardId:string,value:unknown) {
 owner(actor)
 const v=object(value);keys(v,['revision'])
 const revision=integer(v.revision,'revision',1),dashboard=await getDashboard(env.DB,dashboardId)
 if(dashboard.revision!==revision)throw new Fault('dashboard_changed',409)
 await commit(env,actor,'metrics.configure',dashboardId,'completed',[
  env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_metric_dashboards WHERE id=? AND revision=?').bind(dashboardId,revision),
  env.DB.prepare('DELETE FROM hnd_metric_dashboards WHERE id=? AND revision=?').bind(dashboardId,revision),
 ])
 return {deleted:dashboardId}
}
