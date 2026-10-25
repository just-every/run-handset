import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import type { D1ImportContext, D1Sql } from '../../modules/import-kit/src/d1/types'
import { retireD1ImportCustody, readD1ErasureJournal } from '../../modules/import-kit/src/d1/retirement'
import { targetIdentity } from '../../modules/import-kit/src/d1/erasure-index'
import { destination, namespace, targetKind } from '../import/source'
import { ownerPredicate } from '../import/context'
import { targets } from '../import/targets'
import { checkpoint } from './portability.mjs'
import { erasureEpoch, reportFence } from '../metrics/store'
import { commit } from '../audit/store'
import { Fault, consolePage, escape as e, hidden, id, integer, json, keys, owner, text, type ObjectValue } from '../core'

const sql=(sql:string,...params:unknown[]):D1Sql=>({sql,params})
const guard=(condition:string,...params:unknown[])=>sql(`INSERT INTO hnd_guard(ok) SELECT CASE WHEN (${condition}) THEN 1 ELSE 0 END`,...params)
const reportScope=`EXISTS(SELECT 1 FROM json_each(hnd_metric_reports.value,'$.sourceRevisions') s WHERE json_extract(s.value,'$.id')=?)`
function context(env:Bindings,actor:Session):D1ImportContext {
 return {destination,namespace,mappingVersion:'handset-queue-dataset-v1',storage:{database:env.DB,targets},authorization:{principalId:actor.operator.id,predicate:()=>ownerPredicate(actor)}}
}
async function erase(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['entity','targetId','revision','confirm'])
 if(v.entity!=='queue-dataset')throw new Fault('erasure_entity_not_supported',409)
 if(v.confirm!=='erase this exact dataset and retained copies')throw new Fault('explicit_erasure_consent_required',403)
 const target=text(v.targetId,'targetId'),revision=integer(v.revision,'revision',1),db=env.DB,hash=targetIdentity(destination,targetKind,target)
 const row=await db.prepare('SELECT revision,value FROM hnd_metric_datasets WHERE id=?').bind(target).first<{revision:number;value:string}>()
 if(!row)throw new Fault('dataset_not_found',404)
 if(row.revision!==revision)throw new Fault('dataset_changed',409)
 // Sending jobs may already have released an external copy. Do not claim recall.
 const sending=await db.prepare("SELECT count(*) AS n FROM hnd_metric_schedules WHERE state='sending'").first<{n:number}>()
 if(sending?.n)throw new Fault('report_delivery_in_flight',409)
 const operation=id()
 const native:D1Sql[]=[
  guard('(SELECT count(*) FROM hnd_metric_datasets WHERE id=? AND revision=? AND value=?)=1',target,revision,row.value),
  guard("NOT EXISTS(SELECT 1 FROM hnd_metric_schedules WHERE state='sending')"),
  sql('INSERT INTO hnd_erasure_guard VALUES (?)',operation),
  sql(`INSERT INTO hnd_dataset_erasures SELECT ?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,
   (SELECT count(*) FROM hnd_metric_import_revisions WHERE id=?),
   (SELECT count(*) FROM hnd_metric_reports WHERE ${reportScope}),
   (SELECT count(*) FROM hnd_metric_schedules WHERE state='scheduled' OR report_id IN (SELECT id FROM hnd_metric_reports WHERE ${reportScope}))`,operation,hash,target,target,target),
  sql(`UPDATE hnd_metric_schedules SET state=CASE WHEN state='scheduled' THEN 'refused' ELSE state END,report_id=NULL
   WHERE state='scheduled' OR report_id IN (SELECT id FROM hnd_metric_reports WHERE ${reportScope})`,target),
  sql(`DELETE FROM hnd_metric_reports WHERE ${reportScope}`,target),
  ...targets.remove(destination,targetKind,target),
  sql('DELETE FROM hnd_erasure_guard WHERE operation=?',operation),
 ]
 const proof=await retireD1ImportCustody({target:{kind:targetKind,id:target}},native,context(env,actor),await checkpoint(db))
 const receipt=await db.prepare('SELECT * FROM hnd_dataset_erasures WHERE id=?').bind(operation).first()
 // The durable anonymous receipt above is in the deletion transaction; this
 // additional audit event contains no selected identifier or imported content.
 await commit(env,actor,'erasure.complete',operation,'completed')
 return {receipt,importCustody:proof,scope:'queue-dataset',installationErasureComplete:false,externalCopies:'Already delivered messages and downloaded archives remain outside local recall.',offlineRestore:'An offline receiving installation must be given the later erasure journal to reject an older archive.'}
}
export async function erasureDoor(request:Request,env:Bindings,actor:Session,v?:ObjectValue):Promise<Response>{
 owner(actor)
 const url=new URL(request.url),html=url.pathname.startsWith('/app/'),base=html?'/app/admin/erasure':'/api/handset/erasure'
 if(url.search||![base,base+'/erase'].includes(url.pathname))throw new Fault('not_found',404)
 if(request.method==='GET'&&url.pathname===base){
  const epoch=await erasureEpoch(env.DB),datasets=(await env.DB.prepare('SELECT id,revision FROM hnd_metric_datasets ORDER BY id LIMIT 101').all<{id:string;revision:number}>()).results
  const receipts=(await env.DB.prepare('SELECT * FROM hnd_dataset_erasures ORDER BY committed_at DESC LIMIT 100').all()).results
  const importJournal=await readD1ErasureJournal(context(env,actor))
  await commit(env,actor,'erasure.read','installation','completed',[reportFence(env.DB,epoch)])
  if(!html)return json({datasets,receipts,importJournal,installationErasureComplete:false})
  return consolePage('Erase imported queue data',`<p>Owner settings · <a href="/app/import">Import history</a></p><p>This door erases one imported queue dataset, its retained source content and dependent local report snapshots. Pending reports are stopped. Other personal data, media, legal holds and provider copies require further erasure work; complete installation erasure is unavailable.</p><p>Already delivered messages and downloaded archives cannot be recalled. An offline receiving installation needs the later erasure journal before restoring an older archive.</p><h2>Review exact dataset</h2>${datasets.length?datasets.map(row=>`<form method="post" action="${base}/erase">${hidden('entity','queue-dataset')}${hidden('targetId',row.id)}${hidden('revision',row.revision)}<p style="overflow-wrap:anywhere">Dataset ${e(row.id)} · revision ${row.revision}</p><label><input type="checkbox" name="confirm" value="erase this exact dataset and retained copies" required>Erase this exact dataset and retained copies, including whole affected import originals</label><button>Erase dataset</button></form>`).join(''):'<p>No imported datasets remain.</p>'}<h2>Committed deletion receipts</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${e(JSON.stringify({receipts,importJournal},null,2))}</pre>`)
 }
 if(request.method==='POST'&&url.pathname===base+'/erase'&&v){
  if(html&&typeof v.revision==='string')v.revision=Number(v.revision)
  const result=await erase(env,actor,v)
  return html?consolePage('Dataset deletion committed',`<p>The selected dataset cascade committed. Complete installation erasure is unavailable.</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${e(JSON.stringify(result,null,2))}</pre><a href="${base}">Return to erasure settings</a>`):json(result)
 }
 throw new Fault('method_not_allowed',405)
}
