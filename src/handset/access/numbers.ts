import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, escape as e, field, hidden, id, integer, keys, owner, ownerFence, text, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import type { AppliedPolicy } from '../audit/policy'

export interface NumberAccess {
 id:string;revision:1;person_id:string;person_version:number;number_id:string;
 created_by:string;owner_version:number;expires_at:number;revoked_at:number|null;created_at:number;
}
interface Person {id:string;display_name:string;role:string;version:number}
interface NativeNumber {id:string;e164:string}
type ListedAccess=NumberAccess & {status:'active'|'revoked'|'expired'|'suspended'}
// Evaluate expiry when the statement executes, including audit transaction retries.
const clock="CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER)"
const sql=(env:Bindings,q:string,...args:(string|number|null)[])=>env.DB.prepare(q).bind(...args)
const guard=(env:Bindings,q:string,...args:(string|number|null)[])=>sql(env,'INSERT INTO hnd_guard(ok) '+q,...args)
const applied=(g:NumberAccess):AppliedPolicy=>({access:{id:g.id,revision:g.revision,ownerVersion:g.owner_version}})
const live=`g.revision=1 AND g.revoked_at IS NULL AND g.expires_at>${clock}
 AND p.status='active' AND p.version=g.person_version
 AND issuer.status='active' AND issuer.role='owner' AND issuer.version=g.owner_version`
const joins='FROM hnd_number_access g JOIN oa_operators p ON p.id=g.person_id JOIN oa_operators issuer ON issuer.id=g.created_by'
function nativeFence(env:Bindings,actor:Session){
 return guard(env,`SELECT count(*) FROM oa_sessions session JOIN oa_operators p ON p.id=session.operator_id
 WHERE session.id=? AND p.id=? AND p.version=? AND p.role=? AND p.status='active'
 AND session.operator_version=p.version AND session.revoked_at IS NULL AND session.expires_at>${clock}`,
 actor.id,actor.operator.id,actor.operator.version,actor.operator.role)
}
function accessFence(env:Bindings,actor:Session,g:NumberAccess){
 return guard(env,`SELECT count(*) ${joins} JOIN hnd_records n ON n.id=g.number_id
 WHERE g.id=? AND g.person_id=? AND g.person_version=? AND g.number_id=? AND n.kind='number' AND ${live}`,
 g.id,actor.operator.id,actor.operator.version,g.number_id)
}

/** Include these fences in the same transaction as the authorized read or write.
 * This capability permits canonical case work and inbound source consent only. */
export async function authorizeNumber(env:Bindings,actor:Session,numberId:string):Promise<{fences:D1PreparedStatement[];applied:AppliedPolicy;grant:NumberAccess|null}>{
 text(numberId,'numberId')
 if(actor.operator.role==='owner')return {fences:[ownerFence(env.DB,actor),nativeFence(env,actor)],applied:{},grant:null}
 const grant=await sql(env,`SELECT g.* ${joins} JOIN hnd_records n ON n.id=g.number_id
 WHERE g.person_id=? AND g.person_version=? AND g.number_id=? AND n.kind='number' AND ${live}
 ORDER BY g.created_at DESC,g.id LIMIT 1`,actor.operator.id,actor.operator.version,numberId).first<NumberAccess>()
 if(!grant)throw new Fault('number_access_required',403)
 return {fences:[nativeFence(env,actor),accessFence(env,actor,grant)],applied:applied(grant),grant}
}

/** Historical number records remain selectable so retained cases keep exact scope. */
export async function allowedNumbers(env:Bindings,actor:Session):Promise<string[]>{
 const selected=actor.operator.role==='owner'
  ?sql(env,"SELECT id AS number_id FROM hnd_records WHERE kind='number' ORDER BY id")
  :sql(env,`SELECT DISTINCT g.number_id ${joins} JOIN hnd_records n ON n.id=g.number_id
    WHERE g.person_id=? AND g.person_version=? AND n.kind='number' AND ${live} ORDER BY g.number_id`,actor.operator.id,actor.operator.version)
 const result=await env.DB.batch([nativeFence(env,actor),selected,sql(env,'DELETE FROM hnd_guard')])
 return (result[1].results as unknown as {number_id:string}[]).map(r=>r.number_id)
}

export async function createNumberAccess(env:Bindings,actor:Session,v:ObjectValue):Promise<NumberAccess>{
 owner(actor);keys(v,['personId','personVersion','numberId','expiresAt','confirm'])
 if(v.confirm!=='approve exact person number work and inbound source consent')throw new Fault('explicit_number_access_confirmation_required')
 const personId=text(v.personId,'personId'),personVersion=integer(v.personVersion,'personVersion',1),numberId=text(v.numberId,'numberId'),now=Date.now()
 const expiresAt=integer(v.expiresAt,'expiresAt',now+1,now+86400000)
 const person=await sql(env,"SELECT id FROM oa_operators WHERE id=? AND version=? AND status='active'",personId,personVersion).first()
 if(!person)throw new Fault('person_version_changed',409)
 if(!await sql(env,"SELECT id FROM hnd_records WHERE id=? AND kind='number'",numberId).first())throw new Fault('native_number_required')
 const grant:NumberAccess={id:id(),revision:1,person_id:personId,person_version:personVersion,number_id:numberId,created_by:actor.operator.id,owner_version:actor.operator.version,expires_at:expiresAt,revoked_at:null,created_at:now}
 await commit(env,actor,'scope.grant',grant.id,'completed',[
  nativeFence(env,actor),guard(env,`SELECT count(*) FROM oa_operators p JOIN hnd_records n ON n.id=?
   WHERE p.id=? AND p.version=? AND p.status='active' AND n.kind='number' AND ?>${clock}`,numberId,personId,personVersion,expiresAt),
  sql(env,'INSERT INTO hnd_number_access(id,revision,person_id,person_version,number_id,created_by,owner_version,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',grant.id,grant.revision,grant.person_id,grant.person_version,grant.number_id,grant.created_by,grant.owner_version,grant.expires_at,grant.revoked_at,grant.created_at),
 ],true,applied(grant))
 return grant
}

export async function revokeNumberAccess(env:Bindings,actor:Session,v:ObjectValue){
 owner(actor);keys(v,['accessId'])
 const accessId=text(v.accessId,'accessId'),grant=await sql(env,'SELECT * FROM hnd_number_access WHERE id=?',accessId).first<NumberAccess>()
 if(!grant)throw new Fault('number_access_not_found',404)
 await commit(env,actor,'scope.revoke',grant.id,'completed',[
  nativeFence(env,actor),guard(env,'SELECT count(*) FROM hnd_number_access WHERE id=? AND person_id=? AND number_id=?',grant.id,grant.person_id,grant.number_id),
  // Include expired and suspended grants: reactivation must not resurrect a parallel grant.
  sql(env,`UPDATE hnd_number_access SET revoked_at=${clock} WHERE person_id=? AND number_id=? AND revoked_at IS NULL`,grant.person_id,grant.number_id),
 ],true,applied(grant))
 return {revoked:true}
}

/** Owner-only metadata and exact native selections, read under the native fence. */
export async function listNumberAccess(env:Bindings,actor:Session){
 owner(actor)
 const result=await env.DB.batch([
  ownerFence(env.DB,actor),nativeFence(env,actor),
  sql(env,`SELECT g.*,CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked' WHEN g.expires_at<=${clock} THEN 'expired' WHEN ${live} THEN 'active' ELSE 'suspended' END AS status ${joins} ORDER BY g.created_at DESC,g.id`),
  sql(env,"SELECT id,display_name,role,version FROM oa_operators WHERE status='active' ORDER BY display_name,id"),
  sql(env,"SELECT id,json_extract(data,'$.e164') AS e164 FROM hnd_records WHERE kind='number' ORDER BY occurred_at DESC,id"),
  sql(env,'DELETE FROM hnd_guard'),
 ])
 return {access:result[2].results as unknown as ListedAccess[],people:result[3].results as unknown as Person[],numbers:result[4].results as unknown as NativeNumber[]}
}

export async function numberAccessForm(env:Bindings,actor:Session):Promise<string>{
 if(actor.operator.role!=='owner')return ''
 const {access,people,numbers}=await listNumberAccess(env,actor),expiry=new Date(Date.now()+3600000).toISOString().slice(0,16)
 return `<section data-number-access><h2>Owner: number work access</h2><p>Choose one active native person, one exact native number record and an expiry within 24 hours. This permits canonical case work and signed inbound source consent for that number. Historical number records permit retained case work; inbound sources require the current number record. No outbound, capture, playback, audit, port or administrative authority is granted.</p>
 <form method="post" action="/app/sources/access"><label for="number-person">Exact number worker</label><select id="number-person" name="personChoice" required><option value="">Choose a person</option>${people.map(p=>`<option value="${e(p.id)}:${p.version}">${e(p.display_name)} · ${e(p.role)}</option>`).join('')}</select><label for="number-record">Selected native number record ID</label><select id="number-record" name="numberId" required><option value="">Choose a number record</option>${numbers.map(n=>`<option value="${e(n.id)}">${e(n.e164)} · ${e(n.id)}</option>`).join('')}</select>${field('Number access expiry (UTC, within one day)','expiresAt',expiry,'datetime-local')}<label><input type="checkbox" name="confirm" value="approve exact person number work and inbound source consent" required>I approve case work and inbound source consent for this exact person and number</label><button>Grant number work</button></form>
 <h3>Number work capabilities</h3><p>Changed native person or issuing owner versions suspend access. Revoking any grant revokes all parallel grants for that person and number.</p><ul>${access.map(g=>`<li>${e(people.find(p=>p.id===g.person_id)?.display_name??g.person_id)} · Number ${e(g.number_id)} · ${e(g.status)} · expires ${e(new Date(g.expires_at).toISOString())}${g.revoked_at===null?`<form method="post" action="/app/sources/revoke-access">${hidden('accessId',g.id)}<button>Revoke number work ${e(g.id)}</button></form>`:''}</li>`).join('')||'<li>No number work capabilities.</li>'}</ul></section>`
}

/** Server-selected aliases only. Person/source values always come from joined rows. */
export function sourceConsentClause(sourceAlias='s',personAlias='o'):string{
 if(!/^[a-z_][a-z0-9_]*$/i.test(sourceAlias)||!/^[a-z_][a-z0-9_]*$/i.test(personAlias))throw new Error('Invalid server SQL alias')
 return `((${sourceAlias}.consent_access_id IS NULL AND ${personAlias}.role='owner') OR EXISTS(
  SELECT 1 FROM hnd_number_access consent_cap JOIN oa_operators consent_issuer ON consent_issuer.id=consent_cap.created_by
  WHERE consent_cap.id=${sourceAlias}.consent_access_id AND consent_cap.revision=1
  AND consent_cap.number_id=${sourceAlias}.number_id AND consent_cap.person_id=${personAlias}.id
  AND consent_cap.person_version=${personAlias}.version AND consent_cap.revoked_at IS NULL AND consent_cap.expires_at>${clock}
  AND consent_issuer.role='owner' AND consent_issuer.status='active' AND consent_issuer.version=consent_cap.owner_version))`
}
