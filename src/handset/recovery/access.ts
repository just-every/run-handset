import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { append, commit } from '../audit/store'
import { Fault, id, integer, keys, owner, ownerFence, text, type ObjectValue } from '../core'
import { guard, sql } from '../delegation/store'

export const capabilities=['read','work','takeover','stop','decline','schedule','cancel','assign'] as const
export type Capability=typeof capabilities[number]
interface Grant {id:string;person_id:string;person_version:number;number_id:string;capabilities:string;fallback_id:string;fallback_version:number;created_by:string;owner_version:number;expires_at:number;revoked_at:number|null;created_at:number}
export interface Work {id:string;source_id:string;owner_id:string;revision:number}
const live=`g.revoked_at IS NULL AND g.expires_at>? AND p.status='active' AND p.version=g.person_version AND issuer.status='active' AND issuer.role='owner' AND issuer.version=g.owner_version AND f.status='active' AND f.role='owner' AND f.version=g.fallback_version`
const joins=`FROM hnd_recovery_access g JOIN oa_operators p ON p.id=g.person_id JOIN oa_operators issuer ON issuer.id=g.created_by JOIN oa_operators f ON f.id=g.fallback_id`
export async function accessGrant(env:Bindings,personId:string,numberId:string,cap:Capability) {
 return sql(env,`SELECT g.* ${joins} WHERE g.person_id=? AND g.number_id=? AND ${live} AND EXISTS(SELECT 1 FROM json_each(g.capabilities) WHERE value=?) ORDER BY g.created_at DESC,g.id LIMIT 1`,personId,numberId,Date.now(),cap).first<Grant>()
}
export function grantFence(env:Bindings,g:Grant,cap:Capability) {
 return guard(env,`SELECT count(*) ${joins} WHERE g.id=? AND ${live} AND EXISTS(SELECT 1 FROM json_each(g.capabilities) WHERE value=?)`,g.id,Date.now(),cap)
}
export async function assigneeAuthority(env:Bindings,personId:string,sourceId:string,cap:Capability) {
 const source=await sql(env,'SELECT number_id FROM hnd_sources WHERE id=?',sourceId).first<{number_id:string}>()
 const g=source&&await accessGrant(env,personId,source.number_id,cap)
 if(!g)throw new Fault('assignee_recovery_scope_required',403)
 return [grantFence(env,g,cap)]
}
export async function callbackAuthority(env:Bindings,cb:{owner_id:string;owner_version:number;recovery_id:string}) {
 const person=await sql(env,"SELECT role FROM oa_operators WHERE id=? AND version=? AND status='active'",cb.owner_id,cb.owner_version).first<{role:string}>()
 if(!person)throw new Fault('callback_worker_authority_ended',409)
 const fences=[guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'",cb.owner_id,cb.owner_version)]
 if(person.role==='owner')return fences
 const row=await sql(env,'SELECT source_id,owner_id,revision FROM hnd_recovery WHERE id=?',cb.recovery_id).first<{source_id:string;owner_id:string;revision:number}>()
 if(!row||row.owner_id!==cb.owner_id)throw new Fault('callback_assignment_changed',409)
 return [...fences,guard(env,'SELECT count(*) FROM hnd_recovery WHERE id=? AND owner_id=? AND revision=?',cb.recovery_id,cb.owner_id,row.revision),...await assigneeAuthority(env,cb.owner_id,row.source_id,'schedule')]
}
export async function recoveryAuthority(env:Bindings,actor:Session,row:Work,cap:Capability) {
 if(actor.operator.role==='owner')return [ownerFence(env.DB,actor)]
 if(row.owner_id!==actor.operator.id)throw new Fault('assigned_recovery_required',403)
 const source=await sql(env,'SELECT number_id FROM hnd_sources WHERE id=?',row.source_id).first<{number_id:string}>()
 const grant=source&&await accessGrant(env,actor.operator.id,source.number_id,cap)
 if(!grant||grant.person_version!==actor.operator.version)throw new Fault('recovery_capability_required',403)
 return [guard(env,`SELECT count(*) ${joins} JOIN oa_sessions session ON session.operator_id=p.id JOIN hnd_recovery r ON r.owner_id=p.id JOIN hnd_sources s ON s.id=r.source_id AND s.number_id=g.number_id
 WHERE g.id=? AND r.id=? AND r.revision=? AND p.version=? AND session.id=? AND session.operator_version=p.version AND session.revoked_at IS NULL AND session.expires_at>? AND ${live} AND EXISTS(SELECT 1 FROM json_each(g.capabilities) WHERE value=?)`,grant.id,row.id,row.revision,actor.operator.version,actor.id,Date.now(),Date.now(),cap)]
}
export async function grantRecovery(env:Bindings,actor:Session,v:ObjectValue) {
 owner(actor);keys(v,['personId','personVersion','numberId','capabilities','fallbackId','expiresAt','confirm'])
 if(v.confirm!=='approve scoped recovery work')throw new Fault('explicit_recovery_scope_required',403)
 const personId=text(v.personId,'personId'),version=integer(v.personVersion,'personVersion',1),numberId=text(v.numberId,'numberId'),fallbackId=text(v.fallbackId,'fallbackId')
 if(!Array.isArray(v.capabilities)||!v.capabilities.length||v.capabilities.some(c=>!capabilities.includes(c as Capability))||!v.capabilities.includes('read'))throw new Fault('invalid_capabilities')
 const person=await sql(env,"SELECT version FROM oa_operators WHERE id=? AND version=? AND status='active'",personId,version).first()
 const fallback=await sql(env,"SELECT version FROM oa_operators WHERE id=? AND role='owner' AND status='active'",fallbackId).first<{version:number}>()
 if(!person||!fallback||!await sql(env,"SELECT 1 FROM hnd_records WHERE id=? AND kind='number'",numberId).first())throw new Fault('active_person_number_and_fallback_required',409)
 const g:Grant={id:id(),person_id:personId,person_version:version,number_id:numberId,capabilities:JSON.stringify([...new Set(v.capabilities)]),fallback_id:fallbackId,fallback_version:fallback.version,created_by:actor.operator.id,owner_version:actor.operator.version,expires_at:integer(v.expiresAt,'expiresAt',Date.now()+1,Date.now()+86400000),revoked_at:null,created_at:Date.now()}
 await commit(env,actor,'scope.grant',g.id,'completed',[
  guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'",personId,version),
  guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND role='owner' AND status='active'",fallbackId,fallback.version),
  sql(env,'INSERT INTO hnd_recovery_access VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',...Object.values(g)),
 ])
 return {grant:g}
}
export async function revokeRecovery(env:Bindings,actor:Session,v:ObjectValue) {
 owner(actor);keys(v,['accessId','fallbackId','confirm'])
 if(v.confirm!=='confirm recovery fallback')throw new Fault('fallback_confirmation_required',403)
 const g=await sql(env,'SELECT * FROM hnd_recovery_access WHERE id=?',text(v.accessId,'accessId')).first<Grant>()
 if(!g)throw new Fault('recovery_scope_not_found',404)
 if(v.fallbackId!==g.fallback_id)throw new Fault('review_named_fallback',409)
 await commit(env,actor,'scope.revoke',g.id,'completed',[
  guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND role='owner' AND status='active'",g.fallback_id,g.fallback_version),
  sql(env,'UPDATE hnd_recovery_access SET revoked_at=? WHERE person_id=? AND number_id=? AND revoked_at IS NULL',Date.now(),g.person_id,g.number_id),
  ...fallbackStatements(env,g),
 ])
 return {revoked:true,fallbackId:g.fallback_id}
}
function fallbackStatements(env:Bindings,g:Grant) {
 const owned="SELECT r.id FROM hnd_recovery r JOIN hnd_sources s ON s.id=r.source_id WHERE r.owner_id=? AND s.number_id=? AND r.state NOT IN ('resolved','declined')"
 return [sql(env,`UPDATE hnd_callbacks SET state='cancelled',reason='Recovery scope ended; fallback owner must review',revision=revision+1 WHERE state='waiting' AND recovery_id IN (${owned})`,g.person_id,g.number_id),
 sql(env,`INSERT INTO hnd_recovery_events SELECT lower(hex(randomblob(16))),r.id,'authority_fallback',?,?,? FROM hnd_recovery r WHERE r.id IN (${owned})`,JSON.stringify({previousOwner:g.person_id,fallbackOwner:g.fallback_id}),g.created_by,Date.now(),g.person_id,g.number_id),
 sql(env,`UPDATE hnd_recovery SET owner_id=?,owner_version=?,reason='Recovery scope ended; named fallback owns this need',revision=revision+1,updated_at=? WHERE id IN (${owned})`,g.fallback_id,g.fallback_version,Date.now(),g.person_id,g.number_id)]
}
export async function recoverLostAuthority(env:Bindings) {
 const grants=(await sql(env,`SELECT g.* ${joins} WHERE NOT (${live}) AND EXISTS(SELECT 1 FROM hnd_recovery r JOIN hnd_sources s ON s.id=r.source_id WHERE r.owner_id=g.person_id AND s.number_id=g.number_id AND r.state NOT IN ('resolved','declined')) ORDER BY g.created_at DESC`,Date.now()).all<Grant>()).results
 for(const g of grants) {
  if(await accessGrant(env,g.person_id,g.number_id,'work'))continue
  // Never choose a substitute silently if the explicitly named fallback also lost authority.
  if(!await sql(env,"SELECT 1 FROM oa_operators WHERE id=? AND version=? AND role='owner' AND status='active'",g.fallback_id,g.fallback_version).first())continue
  await append(env,g.id,'recovery.change',g.id,'completed',[guard(env,`SELECT CASE WHEN EXISTS(SELECT 1 ${joins} WHERE g.person_id=? AND g.number_id=? AND ${live} AND EXISTS(SELECT 1 FROM json_each(g.capabilities) WHERE value='work')) THEN 0 ELSE 1 END`,g.person_id,g.number_id,Date.now()),guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND role='owner' AND status='active'",g.fallback_id,g.fallback_version),...fallbackStatements(env,g)])
 }
}
export async function accessSnapshot(env:Bindings,actor:Session) {
 if(actor.operator.role!=='owner')return {}
 return {access:(await sql(env,'SELECT * FROM hnd_recovery_access ORDER BY created_at DESC LIMIT 100').all()).results,
 people:(await sql(env,"SELECT id,version,role,display_name FROM oa_operators WHERE status='active' ORDER BY display_name").all()).results,
 numbers:(await sql(env,"SELECT id,json_extract(data,'$.e164') AS e164 FROM hnd_records WHERE kind='number'").all()).results}
}
