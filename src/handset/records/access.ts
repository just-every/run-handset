import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, ownerFence } from '../core'
import type { AppliedPolicy, Revision } from '../audit/policy'
import { allowedNumbers, authorizeNumber } from '../access/numbers'

export interface CaseAuthority { fences:D1PreparedStatement[]; applied:AppliedPolicy }
// Historical links define scope. Revoking a source or correcting a native
// number does not remove that number from the retained case's authorization.
export const caseNumberRows = `
 SELECT case_id,id AS number_id FROM hnd_records WHERE kind='number' AND case_id IS NOT NULL
 UNION SELECT c.case_id,s.number_id FROM hnd_source_cases c JOIN hnd_sources s ON s.id=c.source_id
 UNION SELECT r.case_id,s.number_id FROM hnd_records r
 JOIN hnd_record_sources rs ON rs.record_id=r.id JOIN hnd_sources s ON s.id=rs.source_id
 WHERE r.case_id IS NOT NULL`

export async function caseNumbers(env:Bindings,caseId:string):Promise<string[]> {
 const rows=await env.DB.prepare(`WITH case_numbers AS (${caseNumberRows})
 SELECT number_id FROM case_numbers WHERE case_id=? ORDER BY number_id`).bind(caseId).all<{number_id:string}>()
 return rows.results.map(row=>row.number_id)
}

/** Bind the exact sorted set, rather than only checking its known members.
 * A source callback adding another number must abort this authorization. */
export function caseScopeFence(env:Bindings,caseId:string,numbers:string[]):D1PreparedStatement {
 const snapshot=JSON.stringify([...new Set(numbers)].sort())
 return env.DB.prepare(`INSERT INTO hnd_guard(ok) WITH case_numbers AS (${caseNumberRows})
 SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_cases WHERE id=?) AND
 (SELECT json_group_array(number_id) FROM
  (SELECT number_id FROM case_numbers WHERE case_id=? ORDER BY number_id))=?
 THEN 1 ELSE 0 END`).bind(caseId,caseId,snapshot)
}

export function combineAuthority(...parts:CaseAuthority[]):CaseAuthority {
 const scopes=new Map<string,Revision>()
 for(const part of parts) {
  for(const scope of [...(part.applied.scopes??[]),...(part.applied.access?[part.applied.access]:[])]) {
   scopes.set(`${scope.id}:${scope.revision}:${scope.ownerVersion??''}`,scope)
  }
 }
 return {fences:parts.flatMap(part=>part.fences),applied:scopes.size?{scopes:[...scopes.values()].sort((a,b)=>a.id.localeCompare(b.id)||a.revision-b.revision)}:{}}
}

/** Commit every returned fence with the read/write and applied policy; disable
 * commit's automatic owner fence for authorized native teammates. */
export async function authorizeCase(env:Bindings,actor:Session,caseId:string):Promise<CaseAuthority> {
 if(actor.operator.role==='owner')return {fences:[ownerFence(env.DB,actor)],applied:{}}
 const numbers=await caseNumbers(env,caseId)
 if(!numbers.length)throw new Fault('case_access_required',403)
 try {
  const parts=await Promise.all(numbers.map(number=>authorizeNumber(env,actor,number)))
  return combineAuthority(...parts,{fences:[caseScopeFence(env,caseId,numbers)],applied:{}})
 } catch(error) {
  if(error instanceof Fault&&error.status===403)throw new Fault('case_access_required',403)
  throw error
 }
}

/** null means unrestricted owner listing. Apply nonowner IDs in the SQL query
 * before filtering, pagination or counts; filtering a LIMIT result is unsafe. */
export async function caseVisibility(env:Bindings,actor:Session):Promise<string[]|null> {
 if(actor.operator.role==='owner')return null
 const numbers=await allowedNumbers(env,actor)
 const rows=await env.DB.prepare(`WITH case_numbers AS (${caseNumberRows})
 SELECT c.id FROM hnd_cases c
 WHERE EXISTS(SELECT 1 FROM case_numbers scope WHERE scope.case_id=c.id)
 AND NOT EXISTS(SELECT 1 FROM case_numbers scope WHERE scope.case_id=c.id
  AND scope.number_id NOT IN(SELECT value FROM json_each(?))) ORDER BY c.id`)
 .bind(JSON.stringify(numbers)).all<{id:string}>()
 return rows.results.map(row=>row.id)
}
