import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, id, json, keys, object, owner, ownerFence, text, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import { definition, list, reviewExpires, type Definition } from './model'

interface Scope { id:string; operator_id:string; operator_version:number; definition:string; permissions:string; created_by:string; owner_version:number; expires_at:number; revoked_at:number|null }
export type Permission = 'issue' | 'approve' | 'standing'
export const within = (wanted:Definition, allowed:Definition) => wanted.budgetCents<=allowed.budgetCents && wanted.policyRevision===allowed.policyRevision && (['scopes','tools','records','numbers','recipients'] as const).every(key=>wanted[key].every(value=>(allowed[key] as string[]).includes(value)))
const liveScope = (s:string,o:string) => `${s}.operator_id=${o}.id AND ${s}.operator_version=${o}.version AND ${s}.revoked_at IS NULL AND ${s}.expires_at>${Date.now()} AND EXISTS(SELECT 1 FROM oa_operators issuer WHERE issuer.id=${s}.created_by AND issuer.role='owner' AND issuer.status='active' AND issuer.version=${s}.owner_version)`
// Persisted rows bind one immutable scope. A replacement scope never revives them.
export const humanAuthority = (row:string) => `(${row}.scope_id IS NULL AND o.role='owner' OR EXISTS(SELECT 1 FROM hnd_authority_scopes scope WHERE scope.id=${row}.scope_id AND ${liveScope('scope','o')}))`
export async function sponsor(env:Bindings,actor:Session,wanted:Definition,permission:Permission,expiresAt:number) {
 if(actor.operator.role==='owner')return {id:null as string|null,fences:[ownerFence(env.DB,actor)]}
 const scopes=(await env.DB.prepare(`SELECT scope.* FROM hnd_authority_scopes scope JOIN oa_operators o ON o.id=scope.operator_id WHERE o.id=? AND o.version=? AND o.status='active' AND ${liveScope('scope','o')}`).bind(actor.operator.id,actor.operator.version).all<Scope>()).results
 const selected=scopes.find(scope=>scope.expires_at>=expiresAt && JSON.parse(scope.permissions).includes(permission) && within(wanted,JSON.parse(scope.definition)))
 if(!selected)throw new Fault('human_scope_required',403)
 const fence=env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_authority_scopes scope JOIN oa_operators o ON o.id=scope.operator_id JOIN oa_sessions session ON session.operator_id=o.id WHERE scope.id=? AND session.id=? AND session.operator_version=o.version AND session.revoked_at IS NULL AND session.expires_at>? AND o.status='active' AND ${liveScope('scope','o')}`).bind(selected.id,actor.id,Date.now())
 return {id:selected.id,fences:[fence]}
}
export async function scopeDoor(request:Request,env:Bindings,actor:Session,v?:ObjectValue):Promise<Response|null> {
 const path=new URL(request.url).pathname,base='/api/handset/grant-scopes'
 if(path!==base&&!path.startsWith(base+'/'))return null
 owner(actor)
 if(request.method==='GET'&&path===base){
  const scopes=(await env.DB.prepare('SELECT * FROM hnd_authority_scopes ORDER BY created_at,id').all()).results
  await commit(env,actor,'grant.read','installation','completed')
  return json({scopes})
 }
 if(request.method!=='POST'||!v)throw new Fault('method_not_allowed',405)
 if(path===base){
  keys(v,['operatorId','definition','permissions','expiresAt','confirm'])
  if(v.confirm!=='delegate exact application authority')throw new Fault('explicit_human_scope_required',403)
  const operatorId=text(v.operatorId,'operatorId'),d=definition(object(v.definition)),permissions=list(v.permissions,'permissions',3),expiresAt=reviewExpires(v.expiresAt)
  if(d.tools.includes('outcome.work'))throw new Fault('caller_outcome_delegation_unavailable',403)
  if(!permissions.length||permissions.some(p=>!['issue','approve','standing'].includes(p)))throw new Fault('invalid_authority_permissions')
  const person=await env.DB.prepare("SELECT version FROM oa_operators WHERE id=? AND status='active'").bind(operatorId).first<{version:number}>()
  if(!person)throw new Fault('active_named_person_required',403)
  const key=id(),now=Date.now()
  await commit(env,actor,'scope.grant',key,'completed',[
   env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'").bind(operatorId,person.version),
   env.DB.prepare('INSERT INTO hnd_authority_scopes VALUES (?,?,?,?,?,?,?,?,NULL,?)').bind(key,operatorId,person.version,JSON.stringify(d),JSON.stringify(permissions),actor.operator.id,actor.operator.version,expiresAt,now),
   env.DB.prepare('INSERT INTO hnd_authority_history VALUES (?,?,?,?,?,?)').bind(id(),key,1,JSON.stringify({definition:d,permissions,operatorId,operatorVersion:person.version,expiresAt}),actor.operator.id,now),
  ])
  return json({id:key,operatorId,definition:d,permissions,expiresAt},201)
 }
 const match=path.slice(base.length).match(/^\/([0-9a-f-]{36})\/revoke$/)
 if(!match)throw new Fault('not_found',404)
 keys(v,[])
 const key=match[1]
 if(!await env.DB.prepare('SELECT id FROM hnd_authority_scopes WHERE id=?').bind(key).first())throw new Fault('scope_not_found',404)
 const linked=`(grant_id IN(SELECT id FROM hnd_grants WHERE scope_id=?) OR approval_id IN(SELECT id FROM hnd_approvals WHERE scope_id=?) OR standing_id IN(SELECT id FROM hnd_standing WHERE scope_id=?))`
 await commit(env,actor,'scope.revoke',key,'completed',[
  env.DB.prepare('UPDATE hnd_authority_scopes SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(Date.now(),key),
  env.DB.prepare(`UPDATE hnd_grants SET reserved_cents=reserved_cents-COALESCE((SELECT SUM(amount_cents) FROM hnd_jobs WHERE grant_id=hnd_grants.id AND status='held_adapter_unqualified' AND ${linked}),0)`).bind(key,key,key),
  env.DB.prepare(`UPDATE hnd_jobs SET status='cancelled' WHERE status='held_adapter_unqualified' AND ${linked}`).bind(key,key,key),
 ])
 return json({revoked:true})
}
