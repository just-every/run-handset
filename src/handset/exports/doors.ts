import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { choice, Fault, headers, id, integer, json, keys, object, owner, session, text, type ObjectValue } from '../core'
import { sql } from '../delegation/store'
import { callCsv, callRows, counts } from './logs'
import { admin, adminFence, custody, event, files, filters, getConnector, getJob, hash, type Connector } from './model'
import { destination, preview } from './transport'
import { approveArchive, archivePreview, artifact, clientReceipt, manifest, prepareArchive, transferArchive } from './archive'
import { destinationPreviewPage, exportsPage, jobPage, settingsPage } from './pages'
import { schedule, tickExports } from './schedules'
export { tickExports } from './schedules'

const filterKeys=['from','to','timezone','queueId','ownerId']
const redirect=(path:string)=>new Response(null,{status:303,headers:{location:path,...headers}})
function formValue(value:ObjectValue,action:string){
 const v={...value}
 for(const name of ['from','to','dueAt'])if(typeof v[name]==='string')v[name]=Date.parse(String(v[name])+'Z')
 for(const name of ['retentionDays','limit'])if(v[name]!==undefined)v[name]=Number(v[name])
 if(action==='/connectors'||action==='/connectors/preview'){
  if(typeof v.destination==='string')v.destination=object(JSON.parse(v.destination))
  else{v.destination=v.provider==='sftp'?{folder:v.folder,host:v.host,user:v.user,port:Number(v.port),hostKey:v.hostKey}:{folder:v.folder};for(const key of ['folder','host','user','port','hostKey'])delete v[key]}
 }
 return v
}
export async function exportDoor(request:Request,original:Bindings,passed:Session,value?:ObjectValue):Promise<Response|null>{
 const url=new URL(request.url),html=url.pathname.startsWith('/app/'),base=html?'/app/exports':'/api/handset/exports'
 if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return null
 const checked=await session(request,original),env=checked.env,actor=checked.session
 if(actor.id!==passed.id)throw new Fault('session_mismatch',403)
 admin(actor)
 await env.DB.batch([adminFence(env,actor),sql(env,'DELETE FROM hnd_guard')])
 const action=url.pathname.slice(base.length),v=html&&value?formValue(value,action):value
 if(url.search&&!(request.method==='GET'&&action==='/csv'))throw new Fault('unexpected_export_query')
 if(request.method==='GET'){
  if(!action){
   await event(env,actor,'exports.read','installation')
   if(html)return exportsPage(env,actor)
   return json({connectors:(await sql(env,'SELECT id,provider,preview,retention_days,revoked_at FROM hnd_export_connectors ORDER BY created_at DESC LIMIT 100').all()).results,jobs:(await sql(env,"SELECT id,state,created_at,error FROM hnd_export_jobs WHERE person_id=? OR ?='owner' ORDER BY created_at DESC LIMIT 100",actor.operator.id,actor.operator.role).all()).results,schedules:(await sql(env,'SELECT * FROM hnd_export_schedules ORDER BY created_at DESC LIMIT 100').all()).results,custody})
  }
  if(html&&action==='/settings'){owner(actor);return settingsPage(env)}
  if(action==='/csv'){
   const data=Object.fromEntries(url.searchParams);keys(data,filterKeys);return csvResponse(env,actor,data)
  }
  const match=action.match(/^\/jobs\/([^/]+)(?:\/(manifest))?$/)
  if(match){const j=await getJob(env,actor,match[1]);await event(env,actor,'exports.read',j.id);if(match[2])return json(await manifest(env,actor,j));return html?jobPage(env,actor,j):json(await archivePreview(env,j))}
  throw new Fault('not_found',404)
 }
 if(request.method!=='POST'||!v)throw new Fault('method_not_allowed',405)
 if(action==='/csv'){keys(v,filterKeys);return csvResponse(env,actor,v)}
 if(action==='/connectors/preview'||action==='/connectors'){
  owner(actor);keys(v,['provider','destination','credential','retentionDays',...(action==='/connectors'?['confirm']:[])])
  const provider=choice(v.provider,['box','dropbox','google-drive','sftp'] as const,'provider'),d=destination(provider,v.destination),retention=integer(v.retentionDays,'retentionDays',1,3650),p=await preview(provider,d,provider==='sftp'?'':text(v.credential,'credential',8000))
  if(action.endsWith('/preview'))return html?destinationPreviewPage({preview:p,provider,destination:d,retentionDays:retention,custody}):json({preview:p,retentionDays:retention,custody})
  if(v.confirm!=='approve scoped destination and separate external custody')throw new Fault('explicit_destination_custody_approval_required',403)
  const target=id();await event(env,actor,'exports.create',target,[sql(env,'INSERT INTO hnd_export_connectors VALUES (?,?,?,?,?,?,?,?,NULL)',target,provider,JSON.stringify(d),JSON.stringify(p),actor.operator.id,actor.operator.version,retention,Date.now())]);return html?redirect('/app/exports/settings'):json({id:target,preview:p,retentionDays:retention,custody},201)
 }
 const connector=action.match(/^\/connectors\/([^/]+)\/revoke$/)
 if(connector){owner(actor);keys(v,[]);const c=await getConnector(env,connector[1]);await event(env,actor,'exports.revoke',c.id,[sql(env,'UPDATE hnd_export_connectors SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',Date.now(),c.id),sql(env,"UPDATE hnd_export_jobs SET state='revoked' WHERE connector_id=?",c.id)]);return html?redirect('/app/exports/settings'):json({revoked:true,custody})}
 if(action==='/jobs'){
  keys(v,[...filterKeys,'connectorId','encryptionKey','confirm']);const target=await prepareArchive(env,actor,v);return html?redirect('/app/exports/jobs/'+target):json(await archivePreview(env,await getJob(env,actor,target)),201)
 }
 const job=action.match(/^\/jobs\/([^/]+)\/(approve|run|receipt|revoke|files\/([^/]+))$/)
 if(job){
  const j=await getJob(env,actor,job[1]),operation=job[2]
  if(operation==='approve'){keys(v,['previewHash','confirm']);await approveArchive(env,actor,j,v)}
  else if(operation==='revoke'){owner(actor);keys(v,[]);await event(env,actor,'exports.revoke',j.id,[sql(env,"UPDATE hnd_export_jobs SET state='revoked' WHERE id=?",j.id)])}
  else if(operation==='run'){keys(v,['credential','encryptionKey','limit']);const result=await transferArchive(env,actor,j,v);return html?jobPage(env,actor,await getJob(env,actor,j.id)):json(result)}
  else if(operation==='receipt'){keys(v,['fileKey','cipherSha256','remotePath','confirm']);return json(await clientReceipt(env,actor,j,v))}
  else{
   keys(v,['encryptionKey']);const c=await getConnector(env,j.connector_id)
   if(c.provider!=='sftp')throw new Fault('sftp_artifact_door_required',409)
   const f=(await files(env,j)).results.find(f=>f.file_key===job[3]);if(!f)throw new Fault('export_file_not_found',404)
   const bytes=await artifact(env,actor,j,f,v.encryptionKey);if(!bytes)return json({state:'unavailable'},409)
   return new Response(bytes,{headers:{...headers,'content-type':'application/octet-stream','content-length':String(bytes.length),'x-handset-cipher-sha256':await hash(bytes)}})
  }
  return html?redirect('/app/exports/jobs/'+j.id):json(await archivePreview(env,await getJob(env,actor,j.id)))
 }
 if(action==='/schedules'){keys(v,[...filterKeys,'recipient','dueAt','emailCopyPolicy','confirm']);const result=await schedule(env,actor,v);return html?redirect('/app/exports'):json(result,201)}
 const cancel=action.match(/^\/schedules\/([^/]+)\/revoke$/)
 if(cancel){owner(actor);keys(v,[]);if(!await sql(env,'SELECT id FROM hnd_export_schedules WHERE id=?',cancel[1]).first())throw new Fault('export_schedule_not_found',404);await event(env,actor,'exports.revoke',cancel[1],[sql(env,"UPDATE hnd_export_schedules SET state='revoked' WHERE id=? AND state='scheduled'",cancel[1])]);return html?redirect('/app/exports'):json({revoked:true,custody})}
 if(action==='/tick'){owner(actor);keys(v,[]);return json({results:await tickExports(env)})}
 throw new Fault('not_found',404)
}
async function csvResponse(env:Bindings,actor:Session,v:ObjectValue){
 const f=filters(v),rows=await callRows(env,f),csv=callCsv(rows,f),summary=counts(rows)
 await event(env,actor,'exports.read','installation')
 return new Response(csv,{headers:{...headers,'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="handset-call-log.csv"','x-handset-call-count':String(summary.callCount),'x-handset-leg-count':String(summary.legCount),'x-handset-row-count':String(summary.rowCount),'x-handset-timezone':f.timezone,'x-handset-csv-sha256':await hash(new TextEncoder().encode(csv))}})
}
