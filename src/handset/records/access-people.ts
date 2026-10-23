import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import type { NumberAccess } from '../access/numbers'
import { Fault } from '../core'
import { authorizeCase, caseNumbers, caseNumberRows, combineAuthority, type CaseAuthority } from './access'

interface Person {id:string;display_name:string;role:string;version:number}
const clock="CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER)"
const live=`g.revision=1 AND g.revoked_at IS NULL AND g.expires_at>${clock}
 AND p.status='active' AND g.person_version=p.version
 AND issuer.status='active' AND issuer.role='owner' AND issuer.version=g.owner_version`
const sql=(env:Bindings,q:string,...args:(string|number|null)[])=>env.DB.prepare(q).bind(...args)
const guard=(env:Bindings,q:string,...args:(string|number|null)[])=>sql(env,'INSERT INTO hnd_guard(ok) '+q,...args)

/** Case-specific assignment choices only. The read itself is fenced; the
 * returned actor authority must still accompany the response audit commit. */
export async function scopedPeople(env:Bindings,actor:Session,caseId:string):Promise<{people:Person[]}&CaseAuthority> {
 const authority=await authorizeCase(env,actor,caseId)
 const selected=actor.operator.role==='owner'
  ?sql(env,"SELECT id,display_name,role,version FROM oa_operators WHERE status='active' ORDER BY display_name,id")
  :sql(env,`WITH case_numbers AS (${caseNumberRows}) SELECT p.id,p.display_name,p.role,p.version
   FROM oa_operators p WHERE p.status='active' AND (p.role='owner' OR
    (EXISTS(SELECT 1 FROM case_numbers n WHERE n.case_id=?) AND
     NOT EXISTS(SELECT 1 FROM case_numbers n WHERE n.case_id=? AND NOT EXISTS(
      SELECT 1 FROM hnd_number_access g JOIN oa_operators issuer ON issuer.id=g.created_by
      WHERE g.person_id=p.id AND g.number_id=n.number_id AND ${live}))))
   ORDER BY p.display_name,p.id`,caseId,caseId)
 const results=await env.DB.batch([...authority.fences,selected,sql(env,'DELETE FROM hnd_guard')])
 return {people:results[authority.fences.length].results as unknown as Person[],...authority}
}

/** Validate a submitted assignment separately from the dropdown. Its exact
 * selected person/version and every covering capability are fenced at write. */
export async function authorizeCaseAssignment(env:Bindings,actor:Session,caseId:string,personId:string):Promise<CaseAuthority> {
 const authority=await authorizeCase(env,actor,caseId)
 const person=await sql(env,"SELECT id,display_name,role,version FROM oa_operators WHERE id=? AND status='active'",personId).first<Person>()
 if(!person)throw new Fault('case_assignment_required',403)
 const personFence=guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND role=? AND status='active'",person.id,person.version,person.role)
 if(actor.operator.role==='owner'||person.role==='owner')return combineAuthority(authority,{fences:[personFence],applied:{}})
 const numbers=await caseNumbers(env,caseId)
 const rows=await sql(env,`SELECT g.* FROM hnd_number_access g JOIN oa_operators p ON p.id=g.person_id
  JOIN oa_operators issuer ON issuer.id=g.created_by WHERE p.id=? AND p.version=?
  AND g.number_id IN(SELECT value FROM json_each(?)) AND ${live} ORDER BY g.created_at DESC,g.id`,
 person.id,person.version,JSON.stringify(numbers)).all<NumberAccess>()
 const chosen=new Map<string,NumberAccess>()
 for(const grant of rows.results)if(!chosen.has(grant.number_id))chosen.set(grant.number_id,grant)
 if(!numbers.length||numbers.some(number=>!chosen.has(number)))throw new Fault('case_assignment_required',403)
 const grants=[...chosen.values()],fences=grants.map(g=>guard(env,`SELECT count(*)
  FROM hnd_number_access g JOIN oa_operators p ON p.id=g.person_id
  JOIN oa_operators issuer ON issuer.id=g.created_by WHERE g.id=? AND p.id=? AND p.version=?
  AND g.number_id=? AND g.owner_version=? AND g.created_by=? AND ${live}`,
 g.id,person.id,person.version,g.number_id,g.owner_version,g.created_by))
 return combineAuthority(authority,{fences:[personFence,...fences],applied:{scopes:grants.map(g=>({id:g.id,revision:g.revision,ownerVersion:g.owner_version}))}})
}
