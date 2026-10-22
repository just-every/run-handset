import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault } from '../core'
import type { NativeOperator } from './model'

export function administrator(actor:Session) {
 if(!['owner','admin'].includes(actor.operator.role))throw new Fault('administrator_required',403)
}
export function adminFence(db:D1Database,actor:Session) {
 return db.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
 WHERE s.id=? AND s.operator_id=? AND s.operator_version=o.version AND o.role=? AND o.role IN ('owner','admin') AND o.status='active'
 AND s.revoked_at IS NULL AND s.expires_at>?`).bind(actor.id,actor.operator.id,actor.operator.role,Date.now())
}
export async function adminCommit(env:Bindings,actor:Session,action:string,subject:string,outcome:string,statements:D1PreparedStatement[]=[]) {
 administrator(actor)
 return commit(env,actor,action,subject,outcome,[adminFence(env.DB,actor),...statements],false)
}
export const mayManage=(actor:Session,targets:NativeOperator[])=>actor.operator.role==='owner'||targets.every(t=>t.role==='member')
export function targetFences(db:D1Database,actor:Session,targets:NativeOperator[]) {
 if(!mayManage(actor,targets))throw new Fault('elevated_target_protected',403)
 return targets.map(t=>db.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND role=? AND status=? AND (?='owner' OR role='member')").bind(t.id,t.version,t.role,t.status,actor.operator.role))
}
export async function profileTargets(db:D1Database,operatorId:string|null,userEmail?:string) {
 if(!operatorId&&!userEmail)return []
 return (await db.prepare('SELECT id,version,status,role,email,display_name FROM oa_operators WHERE id=? OR lower(email)=? ORDER BY id').bind(operatorId,userEmail?.toLowerCase()??null).all<NativeOperator>()).results
}
