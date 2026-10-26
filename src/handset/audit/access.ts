import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { choice, escape as e, Fault, field, hidden, id, integer, keys, ownerFence, text, type ObjectValue } from '../core'
import { commit, denied } from './store'
import type { AppliedPolicy } from './policy'

export interface AuditAccess {
 id:string; revision:1; scope:'installation-audit'; person_id:string; person_version:number;
 created_by:string; owner_version:number; allow_read:1; allow_export:0|1;
 expires_at:number; revoked_at:number|null; created_at:number;
}
interface Person { id:string; display_name:string; role:string; version:number }
// Evaluate time in the transaction, including when the audit append retries.
const clock = "CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER)"
const sql = (env:Bindings,q:string,...args:(string|number|null)[]) => env.DB.prepare(q).bind(...args)
const guard = (env:Bindings,q:string,...args:(string|number|null)[]) => sql(env,'INSERT INTO hnd_guard(ok) '+q,...args)
function nativeFence(env:Bindings,actor:Session) {
 return guard(env,`SELECT count(*) FROM oa_sessions s JOIN oa_operators p ON p.id=s.operator_id
 WHERE s.id=? AND p.id=? AND p.version=? AND p.role=? AND p.status='active'
 AND s.operator_version=p.version AND s.revoked_at IS NULL AND s.expires_at>${clock}`,
 actor.id,actor.operator.id,actor.operator.version,actor.operator.role)
}
const live = `FROM hnd_audit_access g JOIN oa_operators p ON p.id=g.person_id
 JOIN oa_operators issuer ON issuer.id=g.created_by JOIN oa_sessions s ON s.operator_id=p.id
 WHERE s.id=? AND p.id=? AND p.version=? AND p.role=? AND p.status='active'
 AND s.operator_version=p.version AND s.revoked_at IS NULL AND s.expires_at>${clock}
 AND g.person_version=p.version AND issuer.version=g.owner_version AND issuer.role='owner' AND issuer.status='active'
 AND g.scope='installation-audit' AND g.revision=1 AND g.allow_read=1 AND (?=0 OR g.allow_export=1)
 AND g.revoked_at IS NULL AND g.expires_at>${clock}`
const applied = (g:AuditAccess):AppliedPolicy => ({access:{id:g.id,revision:g.revision,ownerVersion:g.owner_version}})
async function requireOwner(env:Bindings,actor:Session,action:'audit.grant'|'audit.revoke'|'audit.read') {
 if(actor.operator.role==='owner')return
 await denied(env,actor,action)
 throw new Fault('owner_required',403)
}

/** The caller must include these fences in the same commit that authorizes the response.
 * These rights never authorize mutation, restoration, anonymization or grant administration. */
export async function authorizeAudit(env:Bindings,actor:Session,cap:'read'|'export') {
 choice(cap,['read','export'],'audit_capability')
 if(actor.operator.role==='owner')return {fences:[ownerFence(env.DB,actor),nativeFence(env,actor)],applied:{} as AppliedPolicy}
 const args = [actor.id,actor.operator.id,actor.operator.version,actor.operator.role,cap==='export'?1:0] as const
 const grant = await sql(env,`SELECT g.* ${live} ORDER BY g.created_at DESC,g.id LIMIT 1`,...args).first<AuditAccess>()
 if(!grant){await denied(env,actor,'audit.'+cap);throw new Fault('audit_capability_required',403)}
 return {fences:[guard(env,`SELECT count(*) ${live} AND g.id=?`,...args,grant.id)],applied:applied(grant)}
}

export async function createAuditAccess(env:Bindings,actor:Session,v:ObjectValue) {
 await requireOwner(env,actor,'audit.grant')
 keys(v,['personId','personVersion','expiresAt','allowExport','confirm'])
 if(v.confirm!=='approve exact person installation audit access')throw new Fault('explicit_audit_access_confirmation_required')
 if(v.allowExport!==undefined && v.allowExport!==false && v.allowExport!==true && v.allowExport!=='1')throw new Fault('invalid_export')
 const personId=text(v.personId,'personId'),now=Date.now(),expiry=integer(v.expiresAt,'expiresAt',now+1,now+86400000)
 const person=await sql(env,"SELECT id,version FROM oa_operators WHERE id=? AND status='active' AND role IN ('owner','admin','member')",personId).first<{id:string;version:number}>()
 if(!person)throw new Fault('active_native_person_required',409)
 if(integer(v.personVersion,'personVersion',1)!==person.version)throw new Fault('person_version_changed',409)
 const g:AuditAccess={id:id(),revision:1,scope:'installation-audit',person_id:person.id,person_version:person.version,created_by:actor.operator.id,owner_version:actor.operator.version,allow_read:1,allow_export:v.allowExport===true||v.allowExport==='1'?1:0,expires_at:expiry,revoked_at:null,created_at:now}
 await commit(env,actor,'audit.grant',g.id,'completed',[
  nativeFence(env,actor),
  guard(env,`SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active' AND role IN ('owner','admin','member') AND ?>${clock}`,person.id,person.version,expiry),
  sql(env,'INSERT INTO hnd_audit_access(id,revision,scope,person_id,person_version,created_by,owner_version,allow_read,allow_export,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',g.id,g.revision,g.scope,g.person_id,g.person_version,g.created_by,g.owner_version,g.allow_read,g.allow_export,g.expires_at,g.revoked_at,g.created_at),
 ],true,applied(g))
 return g
}

export async function revokeAuditAccess(env:Bindings,actor:Session,v:ObjectValue) {
 await requireOwner(env,actor,'audit.revoke');keys(v,['grantId'])
 const target=text(v.grantId,'grantId'),g=await sql(env,'SELECT * FROM hnd_audit_access WHERE id=?',target).first<AuditAccess>()
 if(!g)throw new Fault('audit_access_not_found',404)
 await commit(env,actor,'audit.revoke',g.id,'completed',[
  nativeFence(env,actor),guard(env,'SELECT count(*) FROM hnd_audit_access WHERE id=? AND person_id=?',g.id,g.person_id),
  // Include every parallel unrevoked capability, even if it is already expired or invalidated.
  sql(env,`UPDATE hnd_audit_access SET revoked_at=${clock} WHERE person_id=? AND revoked_at IS NULL`,g.person_id),
 ],true,applied(g))
 return {revoked:true,scope:'all installation audit capabilities for this person'}
}

/** Read the owner choices and capability inventory under the same native transaction fence. */
export async function listAuditAccess(env:Bindings,actor:Session) {
 await requireOwner(env,actor,'audit.read')
 const result=await env.DB.batch([
  ownerFence(env.DB,actor),nativeFence(env,actor),
  sql(env,'SELECT * FROM hnd_audit_access WHERE revoked_at IS NULL ORDER BY created_at DESC,id'),
  sql(env,"SELECT id,display_name,role,version FROM oa_operators WHERE status='active' ORDER BY display_name,id"),
  sql(env,'DELETE FROM hnd_guard'),
 ])
 return {access:result[2].results as unknown as AuditAccess[],people:result[3].results as unknown as Person[]}
}

export async function auditAccessForm(env:Bindings,actor:Session) {
 const {access,people}=await listAuditAccess(env,actor)
 const expiry=new Date(Date.now()+3600000).toISOString().slice(0,16)
 return `<section><h2>Owner: installation audit access</h2><p>Choose one active person and an expiry within 24\u00a0hours. Access permits reading this installation’s audit only. Export requires its own permission. It grants no modification, restoration, anonymization or access administration.</p>
 <form method="post" action="/app/audit/access"><label for="audit-person">Exact audit reader</label><select id="audit-person" name="personChoice" required><option value="">Choose a person</option>${people.map(p=>`<option value="${e(p.id)}:${e(p.version)}">${e(p.display_name)} · ${e(p.role)}</option>`).join('')}</select>${field('Audit access expiry (UTC, within one day)','expiresAt',expiry,'datetime-local')}<label><input type="checkbox" name="allowExport" value="1">Allow audit export</label><label><input type="checkbox" name="confirm" value="approve exact person installation audit access" required>I approve installation audit access for this exact person</label><button>Grant audit access</button></form>
 <h3>Unrevoked audit capabilities</h3><p>Expired capabilities and capabilities whose person or issuing owner has changed are inactive. Revoking any one also revokes every parallel audit capability for that person.</p><ul>${access.map(g=>`<li>${e(people.find(p=>p.id===g.person_id)?.display_name??g.person_id)} · ${g.allow_export?'Read and export':'Read only'} · expires ${e(new Date(g.expires_at).toISOString())}<form method="post" action="/app/audit/revoke">${hidden('grantId',g.id)}<button>Revoke audit access ${e(g.id)}</button></form></li>`).join('')||'<li>No unrevoked audit capabilities.</li>'}</ul></section>`
}
