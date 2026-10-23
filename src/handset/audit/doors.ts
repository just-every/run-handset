import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit, denied, zero, auditBody, actions, type AuditRow } from './store'
import { validPolicy, describePolicy } from './policy'
import { authorizeAudit, auditAccessForm, createAuditAccess, listAuditAccess, revokeAuditAccess } from './access'
import { digest, json, Fault, object, keys, text, integer, owner, session, consolePage as page, escape as e, field, hidden, type ObjectValue } from '../core'

export async function auditExport(env: Bindings) {
 const rows=(await env.DB.prepare('SELECT * FROM hnd_audit ORDER BY sequence LIMIT 10001').all<AuditRow>()).results
 if(rows.length>10000)throw new Fault('audit_archive_limit',413)
 await verifyRows(rows)
 return {schemaVersion:1,project:'just-every/handset',rows,checkpoint:rows.at(-1)?.hash??zero}
}
export async function verifyRows(rows: AuditRow[]) {
 let previous=zero, sequence=0
 for(const row of rows){
  const value=object(row)
  keys(value,['sequence','id','actor','action','policy','subject','outcome','occurred_at','previous_hash','hash','principal'])
  if(row.sequence!==++sequence || row.previous_hash!==previous || row.hash!==await digest(auditBody(row)))throw new Fault('invalid_audit_chain')
  for(const key of ['id','actor','subject'] as const)if(!(row[key]==='installation' && key==='subject') && !(row[key]==='anonymous' && key==='actor') && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row[key]))throw new Fault('invalid_audit_reference')
  if(!actions.includes(row.action) || !validPolicy(row.policy) || !['completed','refused','failed','uncertain'].includes(row.outcome))throw new Fault('invalid_audit_vocabulary')
  if(row.principal!==undefined && row.principal!==null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.principal))throw new Fault('invalid_audit_principal')
  integer(row.occurred_at,'occurred_at')
  previous=row.hash
 }
 return previous
}
export async function restoreAudit(env: Bindings,actor:Session,value:ObjectValue){
 keys(value,['archive','expectedCheckpoint','confirm'])
 if(value.confirm!=='restore evidence only')throw new Fault('explicit_restore_confirmation_required')
 const archive=object(value.archive)
 keys(archive,['schemaVersion','project','rows','checkpoint'])
 if(archive.schemaVersion!==1 || archive.project!=='just-every/handset' || !Array.isArray(archive.rows) || !archive.rows.length || archive.rows.length>10000)throw new Fault('invalid_audit_archive')
 const checkpoint=await verifyRows(archive.rows as AuditRow[])
 if(checkpoint!==archive.checkpoint || checkpoint!==value.expectedCheckpoint)throw new Fault('independent_checkpoint_mismatch')
 if(await env.DB.prepare('SELECT checkpoint FROM hnd_audit_archives WHERE checkpoint=?').bind(checkpoint).first())return {checkpoint,replay:true}
 await commit(env,actor,'audit.restore','installation','completed',[
  env.DB.prepare('INSERT INTO hnd_audit_archives VALUES (?,?,?,?)').bind(checkpoint,JSON.stringify(archive.rows),Date.now(),actor.operator.id),
 ])
 return {checkpoint,replay:false}
}
export async function anonymizeActor(env:Bindings,actor:Session,value:ObjectValue){
 keys(value,['operatorId','confirm'])
 const operatorId=text(value.operatorId,'operatorId')
 if(value.confirm!=='anonymize audit identity')throw new Fault('explicit_anonymization_confirmation_required')
 // No owner erasure or implicit personnel action. Full erasure is HND-066.
 const target=await env.DB.prepare('SELECT role,status FROM oa_operators WHERE id=?').bind(operatorId).first<{role:string;status:string}>()
 if(!target || target.role==='owner' || target.status!=='inactive')throw new Fault('inactive_non_owner_required',409)
 await commit(env,actor,'audit.anonymize','installation','completed',[
  env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND role!='owner' AND status='inactive'").bind(operatorId),
  env.DB.prepare('DELETE FROM hnd_actor_refs WHERE operator_id=?').bind(operatorId),
 ])
 return {anonymized:true,scope:'audit attribution only; product erasure is not claimed'}
}
export async function auditDoor(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response|null>{
 const url=new URL(request.url),path=url.pathname,html=path.startsWith('/app/'),read=request.method==='GET'
 if(!/^\/(api\/handset|app)\/audit(?:\/|$)/.test(path))return null
 const checked=await session(request,env)
 if(checked.session.id!==actor.id)throw new Fault('session_mismatch',403)
 actor=checked.session;env=checked.env
 const base=html?'/app/audit':'/api/handset/audit'
 const owned=actor.operator.role==='owner'
 const receipt=async(action:'audit.read'|'audit.export')=>{
  const authority=await authorizeAudit(env,actor,action==='audit.export'?'export':'read')
  await commit(env,actor,action,'installation','completed',authority.fences,false,authority.applied)
 }
 if(path===base+'/access'&&read){owner(actor);return json(await listAuditAccess(env,actor))}
 if(!read){
  try{owner(actor)}catch(error){await denied(env,actor,'audit.modify');throw error}
  if([base+'/access',base+'/revoke'].includes(path)&&request.method!=='POST')throw new Fault('method_not_allowed',405)
  if(path===base+'/access'&&value){
   const v={...value}
   if(html){
    const choice=text(v.personChoice,'personChoice').split(':')
    if(choice.length!==2)throw new Fault('invalid_personChoice')
    delete v.personChoice;v.personId=choice[0];v.personVersion=Number(choice[1]);v.expiresAt=Date.parse(String(v.expiresAt)+'Z')
   }
   const access=await createAuditAccess(env,actor,v)
   return html?page('Audit access granted',`<p>Exact-person installation audit ${access.allow_export?'read and export':'read-only'} access approved. Capability ${e(access.id)}. No audit mutation or recording access was granted.</p><a href="/app/audit">Return to audit</a>`):json(access,201)
  }
  if(path===base+'/revoke'&&value){const result=await revokeAuditAccess(env,actor,value);return html?page('Audit access revoked','<p>Every parallel audit capability for this person is revoked. Audit history is retained.</p><a href="/app/audit">Return to audit</a>'):json(result)}
 }
 if(read)await authorizeAudit(env,actor,path===base+'/export'||path.startsWith('/api/handset/audit/archive/')?'export':'read')
 if(read && path===base){
  const after=integer(Number(url.searchParams.get('after')??0),'after'), rows=(await env.DB.prepare('SELECT * FROM hnd_audit WHERE sequence>? ORDER BY sequence LIMIT 101').bind(after).all<AuditRow>()).results
  if(!html){const response=json({rows:rows.slice(0,100),next:rows.length>100?rows[99].sequence:null});await receipt('audit.read');return response}
  const archives=(await env.DB.prepare('SELECT checkpoint,imported_at FROM hnd_audit_archives ORDER BY imported_at').all<{checkpoint:string;imported_at:number}>()).results
  const administration=owned?await auditAccessForm(env,actor):''
  const anonymize=owned?`<h2>Anonymize inactive actor</h2><p>This removes the audit identity mapping only. Other product records are not erased.</p><form method="post" action="/app/audit/anonymize">${field('Inactive non-owner operator ID','operatorId')}<label><input type="checkbox" name="confirm" value="anonymize audit identity" required>I approve anonymizing audit identity</label><button>Anonymize audit identity</button></form>`:''
  const response=await page('Accountable audit',`<p>${owned?'Owner access.':'Exact-person installation audit read access. Export requires a separate current approval.'} Append-only history with opaque references. Export a checkpoint and keep it in independent owner storage to detect infrastructure changes.</p><p>Each event retains the authorization schema and the native, source, grant or policy revision applied by that door. Older policy revisions remain verifiable. Exports stop at 10,000 rows; scale beyond that bound is unqualified. Refused playback uses installation scope.</p><p><a href="/api/handset/audit/export">Export checked ledger</a></p>${administration}<ol>${rows.slice(0,100).map(row=>`<li><strong>${e(row.action)} · ${e(row.outcome)}</strong><p>${e(new Date(row.occurred_at).toISOString())} · Actor ${e(row.actor)}${row.principal?` · Principal ${e(row.principal)}`:''} · Subject ${e(row.subject)} · Policy ${e(describePolicy(row.policy))}</p><p>${e(row.hash)}</p></li>`).join('')||'<li>No audit events.</li>'}</ol>${rows.length>100?`<a href="/app/audit?after=${rows[99].sequence}">Next audit page</a>`:''}<h2>Restored ledgers</h2><ul>${archives.map(a=>`<li><a href="/api/handset/audit/archive/${e(a.checkpoint)}">${e(a.checkpoint)}</a></li>`).join('')||'<li>No restored ledgers.</li>'}</ul>${anonymize}`)
  await receipt('audit.read');return response
 }
 if(read && path===base+'/export'){
  const archive=await auditExport(env)
  const response=new Response(JSON.stringify(archive),{headers:{'content-type':'application/json','content-disposition':'attachment; filename="handset-audit.json"','cache-control':'no-store','x-content-type-options':'nosniff'}})
  await receipt('audit.export');return response
 }
 const archive=path.match(/^\/api\/handset\/audit\/archive\/([a-f0-9]{64})$/)
 if(read && archive){
  const stored=await env.DB.prepare('SELECT rows_json FROM hnd_audit_archives WHERE checkpoint=?').bind(archive[1]).first<{rows_json:string}>()
  if(!stored)throw new Fault('archive_not_found',404)
  const response=json({checkpoint:archive[1],rows:JSON.parse(stored.rows_json)})
  await receipt('audit.export');return response
 }
 if(!read && path===base+'/restore' && value)return json(await restoreAudit(env,actor,value),201)
 if(!read && path===base+'/anonymize' && value){const result=await anonymizeActor(env,actor,value);return html?page('Audit identity anonymized','<p>Audit attribution mapping removed. Operational evidence survives.</p>'):json(result)}
 if(!read){await denied(env,actor,'audit.modify');throw new Fault('append_only',403)}
 return null
}
