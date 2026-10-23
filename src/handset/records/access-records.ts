import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, ownerFence, type ObjectValue } from '../core'
import { recordInput, type RecordRow } from './model'
import type { getRecord, RecordLink } from './store'
import { authorizeCase, caseVisibility, combineAuthority, type CaseAuthority } from './access'

const refused=()=>new Fault('record_access_required',403)
interface Reference { id:string; case_id:string|null }
interface RecordDetail {record:RecordRow;links:RecordLink[];related:RecordRow[]}

/** Canonical metadata only: this never authorizes media fetches or playback. */
export async function recordVisibility(env:Bindings,actor:Session,recordId:string):Promise<CaseAuthority> {
 if(actor.operator.role==='owner')return {fences:[ownerFence(env.DB,actor)],applied:{}}
 const record=await env.DB.prepare('SELECT id,case_id FROM hnd_records WHERE id=?').bind(recordId).first<Reference>()
 if(!record)throw refused()
 try {
  if(record.case_id)return await authorizeCase(env,actor,record.case_id)
  const visible=await caseVisibility(env,actor)
  const linked=await env.DB.prepare(`SELECT r.case_id FROM hnd_records r
   WHERE r.case_id IN(SELECT value FROM json_each(?)) AND
   (r.parent_id=? OR EXISTS(SELECT 1 FROM hnd_record_links l
    WHERE (l.record_id=r.id AND l.target_id=?) OR (l.target_id=r.id AND l.record_id=?)))
   ORDER BY r.case_id LIMIT 1`).bind(JSON.stringify(visible),recordId,recordId,recordId).first<{case_id:string}>()
  if(linked)return await authorizeCase(env,actor,linked.case_id)
 } catch(error) {
  if(!(error instanceof Fault&&error.status===403))throw error
 }
 throw refused()
}

/** Filter both endpoints of every bidirectional link and all child metadata.
 * Return the combined authority so no selected metadata escapes its fences. */
export async function scopedRecord(env:Bindings,actor:Session,fetched:Awaited<ReturnType<typeof getRecord>>):Promise<{detail:RecordDetail}&CaseAuthority> {
 const detail={...fetched,links:fetched.links.map(l=>({record_id:String(l.record_id),target_id:String(l.target_id),relation:String(l.relation)}))}
 const primary=await recordVisibility(env,actor,detail.record.id)
 if(actor.operator.role==='owner')return {detail,...primary}
 const ids=[...new Set([
  ...detail.related.flatMap(r=>[r.id,r.parent_id,r.supersedes_id]),...detail.links.flatMap(l=>[l.record_id,l.target_id]),
  detail.record.parent_id,detail.record.supersedes_id,
 ].filter((id):id is string=>Boolean(id)&&id!==detail.record.id))]
 const selected=await Promise.all(ids.map(async id=>{
  try{return {id,authority:await recordVisibility(env,actor,id)}}
  catch(error){if(error instanceof Fault&&error.status===403)return null;throw error}
 }))
 const allowed=new Map(selected.filter((r):r is NonNullable<typeof r>=>r!==null).map(r=>[r.id,r.authority]))
 const visible=(id:string)=>id===detail.record.id||allowed.has(id)
 const sanitize=(r:RecordRow)=>({...r,parent_id:r.parent_id&&visible(r.parent_id)?r.parent_id:null,supersedes_id:r.supersedes_id&&visible(r.supersedes_id)?r.supersedes_id:null})
 return {detail:{record:sanitize(detail.record),related:detail.related.filter(r=>visible(r.id)).map(sanitize),links:detail.links.filter(l=>visible(l.record_id)&&visible(l.target_id))},
  ...combineAuthority(primary,...allowed.values())}
}

export const teammateRecordKinds=['comment','disposition','promise','message'] as const
/** Run before addRecord (including its replay lookup), then include returned
 * fences/policy in the exact transaction. Native entries remain observations. */
export async function authorizeRecordWrite(env:Bindings,actor:Session,value:ObjectValue):Promise<CaseAuthority> {
 if(actor.operator.role==='owner')return {fences:[ownerFence(env.DB,actor)],applied:{}}
 if(typeof value.caseId!=='string'||!value.caseId)throw refused()
 const authority=await authorizeCase(env,actor,value.caseId),v=recordInput(value)
 if(!(teammateRecordKinds as readonly string[]).includes(v.kind))throw refused()
 if(v.kind==='message'&&!['unknown','uncertain'].includes(String(v.data.state)))throw refused()
 const existing=await env.DB.prepare("SELECT case_id FROM hnd_records WHERE kind=? AND source='native' AND source_id=?")
  .bind(v.kind,v.sourceId).first<{case_id:string|null}>()
 // addRecord's source-conflict detail must never disclose another case.
 if(existing&&existing.case_id!==v.caseId)throw refused()
 const ids=[...new Set([v.parentId,v.supersedesId,...v.links.map(l=>l.targetId)].filter((id):id is string=>Boolean(id)))]
 const references=await Promise.all(ids.map(id=>recordVisibility(env,actor,id)))
 return combineAuthority(authority,...references)
}
