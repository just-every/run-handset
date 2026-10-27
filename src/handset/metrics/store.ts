import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { digest, Fault, id } from '../core'
import { calculate } from './formulas'
import { nativeAnalytics } from './native'
import { parseConfig, parseDataset, validateCorrelation, type Config, type Entry, type Segment } from './model'
import type { NativeFilters } from './filters'
import { dashboardFence, type Dashboard } from './dashboards'

export async function datasets(db:D1Database) {
 const rows=(await db.prepare('SELECT * FROM hnd_metric_datasets ORDER BY id').all<{id:string;revision:number;value:string}>()).results
 return rows.map(row=>({id:row.id,revision:row.revision,dataset:parseDataset(JSON.parse(row.value))}))
}
export async function currentConfig(db:D1Database,queueId:string,revision?:number):Promise<Config> {
 const row=revision===undefined?await db.prepare('SELECT value FROM hnd_metric_configs WHERE queue_id=? ORDER BY revision DESC LIMIT 1').bind(queueId).first<{value:string}>():await db.prepare('SELECT value FROM hnd_metric_configs WHERE queue_id=? AND revision=?').bind(queueId,revision).first<{value:string}>()
 if(!row)throw new Fault('queue_metric_config_required',404)
 return parseConfig(JSON.parse(row.value))
}
export async function configs(db:D1Database) {
 const rows=(await db.prepare('SELECT c.value FROM hnd_metric_configs c WHERE c.revision=(SELECT max(n.revision) FROM hnd_metric_configs n WHERE n.queue_id=c.queue_id) ORDER BY c.queue_id').all<{value:string}>()).results
 return rows.map(row=>parseConfig(JSON.parse(row.value)))
}
export async function configure(env:Bindings,actor:Session,value:unknown) {
 const before=parseConfig(value),config={...before,revision:before.revision+1},db=env.DB
 const row=await db.prepare('SELECT max(revision) AS revision FROM hnd_metric_configs WHERE queue_id=?').bind(config.queueId).first<{revision:number|null}>()
 if((row?.revision??0)!==before.revision)throw new Fault('metric_config_changed',409)
 try{await commit(env,actor,'metrics.configure','installation','completed',[
  db.prepare('INSERT INTO hnd_guard(ok) SELECT CASE WHEN COALESCE(max(revision),0)=? THEN 1 ELSE 0 END FROM hnd_metric_configs WHERE queue_id=?').bind(before.revision,config.queueId),
  db.prepare('INSERT INTO hnd_metric_configs VALUES (?,?,?,?,?)').bind(config.queueId,config.revision,JSON.stringify(config),actor.operator.id,Date.now()),
 ])}catch(error){if(String(error).includes('UNIQUE constraint'))throw new Fault('metric_config_changed',409);throw error}
 return config
}
export const erasureEpoch=async(db:D1Database)=>Number((await db.prepare("SELECT count(*) AS n FROM ik_d1_erasure_journal WHERE destination='handset-queue-metrics'").first<{n:number}>())?.n??0)
export const reportFence=(db:D1Database,epoch:number)=>db.prepare("INSERT INTO hnd_guard(ok) SELECT count(*)=? FROM ik_d1_erasure_journal WHERE destination='handset-queue-metrics'").bind(epoch)
export async function liveReport(env:Bindings,config:Config,filters:NativeFilters={},dashboard?:Dashboard) {
 const epoch=await erasureEpoch(env.DB)
 const sources=await datasets(env.DB),entries:Entry[]=[],segments:Segment[]=[],entryValues=new Map<string,string>(),segmentValues=new Map<string,string>()
 for(const source of sources){
  for(const e of source.dataset.entries){const value=JSON.stringify(e),prior=entryValues.get(e.id);if(prior!==undefined&&prior!==value)throw new Fault('source_entry_conflict',409);if(prior===undefined){entryValues.set(e.id,value);entries.push(e)}}
  for(const s of source.dataset.agents){const value=JSON.stringify(s),prior=segmentValues.get(s.id);if(prior!==undefined&&prior!==value)throw new Fault('source_segment_conflict',409);if(prior===undefined){segmentValues.set(s.id,value);segments.push(s)}}
 }
 validateCorrelation(entries,segments)
 const report=calculate(entries,segments,config),native=await nativeAnalytics(env,config,filters)
 return {...report,native,...(dashboard?{dashboard}:{}),erasureEpoch:epoch,sourceRevisions:sources.map(s=>({id:s.id,revision:s.revision})),sourceHash:await digest({sources,native:{...native,capturedAt:0}}),source:'reviewed native datasets; source observations retain their supplied identities'}
}
export async function saveReport(env:Bindings,actor:Session,config:Config,filters:NativeFilters={},dashboard?:Dashboard) {
 const report=await liveReport(env,config,filters,dashboard)
 if(!report.finalized)throw new Fault('provisional_entries_remain',409)
 const reportId=id()
 await commit(env,actor,'metrics.finalize',reportId,'completed',[reportFence(env.DB,report.erasureEpoch),...(dashboard?[dashboardFence(env.DB,dashboard)]:[]),env.DB.prepare('INSERT INTO hnd_metric_reports VALUES (?,?,?,?,?,?)').bind(reportId,config.queueId,config.revision,report.sourceHash,JSON.stringify(report),Date.now())])
 return {id:reportId,...report}
}
