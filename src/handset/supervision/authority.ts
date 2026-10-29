import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, id, keys, owner, text, timestamp, type ObjectValue } from '../core'
import { grantConfirmation, grantLifetimeMs, type Context, type Grant } from './model'

export const nativeSql=`SELECT count(*) FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
 WHERE s.id=? AND o.id=? AND o.version=? AND s.operator_version=o.version
 AND o.status='active' AND s.revoked_at IS NULL AND s.expires_at>?`
export function nativeFence({env,actor}:Context){
 return env.DB.prepare('INSERT INTO hnd_guard(ok) '+nativeSql).bind(actor.id,actor.operator.id,actor.operator.version,Date.now())
}
export async function active(ctx:Context){
 const row=await ctx.env.DB.prepare(nativeSql).bind(ctx.actor.id,ctx.actor.operator.id,ctx.actor.operator.version,Date.now()).first<Record<string,number>>()
 if(!row||Object.values(row)[0]!==1)throw new Fault('supervision_authority_required',403)
}
export async function ownerActive(ctx:Context){
 await active(ctx);owner(ctx.actor)
 const current=await ctx.env.DB.prepare("SELECT id FROM oa_operators WHERE id=? AND role='owner' AND status='active' AND version=?").bind(ctx.actor.operator.id,ctx.actor.operator.version).first()
 if(!current)throw new Fault('owner_required',403)
}
export const validGrantSql=`SELECT g.* FROM hnd_supervision_grants g
 JOIN oa_operators subject ON subject.id=g.operator_id AND subject.version=g.operator_version AND subject.status='active'
 JOIN oa_operators issuer ON issuer.id=g.issued_by AND issuer.version=g.issuer_version AND issuer.status='active' AND issuer.role='owner'
 WHERE g.operator_id=? AND g.queue_id=? AND g.revoked_at IS NULL AND g.expires_at>?`
export async function authorize(ctx:Context,queueId:string,intervention=false){
 await active(ctx)
 const grant=await ctx.env.DB.prepare(validGrantSql+(intervention?' AND g.can_intervene=1':'')+' ORDER BY g.can_intervene DESC,g.created_at DESC,g.id LIMIT 1').bind(ctx.actor.operator.id,queueId,Date.now()).first<Grant>()
 if(!grant){
  await commit(ctx.env,ctx.actor,'product.request','installation','refused',[nativeFence(ctx)],false)
  throw new Fault('supervision_scope_required',403)
 }
 return grant
}
export function scopeFence(ctx:Context,grant:Grant,intervention=false){
 return ctx.env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM ('+validGrantSql+' AND g.id=?'+(intervention?' AND g.can_intervene=1':'')+')')
  .bind(ctx.actor.operator.id,grant.queue_id,Date.now(),grant.id)
}
// Global availability affects every membership, including logged-out memberships.
// A queue-scoped supervisor must hold intervention authority over all of them.
export const sharedScopeSql=`SELECT count(*)=0 FROM hnd_queue_memberships m WHERE m.operator_id=? AND NOT EXISTS (
 SELECT 1 FROM hnd_supervision_grants g JOIN oa_operators subject ON subject.id=g.operator_id
 JOIN oa_operators issuer ON issuer.id=g.issued_by WHERE g.operator_id=? AND g.queue_id=m.queue_id
 AND g.can_intervene=1 AND g.revoked_at IS NULL AND g.expires_at>?
 AND subject.status='active' AND subject.version=g.operator_version
 AND issuer.status='active' AND issuer.role='owner' AND issuer.version=g.issuer_version)`
export async function issueGrant(env:Bindings,actor:Session,value:ObjectValue){
 const ctx={env,actor};await ownerActive(ctx)
 keys(value,['operatorId','queueId','canIntervene','expiresAt','confirm'])
 if(value.confirm!==grantConfirmation)throw new Fault('supervision_consent_required',403)
 if(typeof value.canIntervene!=='boolean')throw new Fault('invalid_canIntervene')
 const operatorId=text(value.operatorId,'operatorId'),queueId=text(value.queueId,'queueId'),expiresAt=timestamp(value.expiresAt,'expiresAt'),now=Date.now()
 if(expiresAt<=now||expiresAt>now+grantLifetimeMs)throw new Fault('supervision_expiry_out_of_bounds')
 const subject=await env.DB.prepare("SELECT version FROM oa_operators WHERE id=? AND status='active'").bind(operatorId).first<{version:number}>()
 if(!subject)throw new Fault('active_supervisor_required',403)
 if(!await env.DB.prepare('SELECT id FROM hnd_queues WHERE id=?').bind(queueId).first())throw new Fault('queue_not_found',404)
 const grantId=id()
 await commit(env,actor,'scope.grant',grantId,'completed',[
  env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'").bind(operatorId,subject.version),
  env.DB.prepare('INSERT INTO hnd_supervision_grants VALUES (?,?,?,?,?,?,?,?,?,NULL)').bind(grantId,operatorId,subject.version,queueId,Number(value.canIntervene),actor.operator.id,actor.operator.version,now,expiresAt),
 ])
 return (await env.DB.prepare('SELECT * FROM hnd_supervision_grants WHERE id=?').bind(grantId).first<Grant>())!
}
export async function revokeGrant(env:Bindings,actor:Session,grantId:string){
 const ctx={env,actor};await ownerActive(ctx)
 const grant=await env.DB.prepare('SELECT * FROM hnd_supervision_grants WHERE id=?').bind(grantId).first<Grant>()
 if(!grant)throw new Fault('supervision_grant_not_found',404)
 await commit(env,actor,'scope.revoke',grantId,'completed',grant.revoked_at===null?[
  env.DB.prepare('UPDATE hnd_supervision_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(Date.now(),grantId),
 ]:[])
 return {id:grantId,revoked:true}
}
