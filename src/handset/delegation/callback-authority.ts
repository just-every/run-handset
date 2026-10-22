import type { Bindings } from '../../auth.server'
import { Fault } from '../core'
import { delegationFence, guard, linePolicy, sql, type Delegation, type Line } from './store'

/** A signed answer callback cannot turn a revoked pending assistant call into a
 * new media bridge. Status readback for already-started calls remains allowed. */
export async function callbackAuthority(env:Bindings,sessionId:string){
 const c=await sql(env,`SELECT c.operation_id,c.expires_at,o.delegation_id,o.line_revision FROM hnd_frontdesk_controls c JOIN hnd_frontdesk_operations o ON o.id=c.operation_id WHERE c.session_id=? AND o.kind='callback'`,sessionId).first<{operation_id:string;expires_at:number;delegation_id:string;line_revision:number}>()
 if(!c)return []
 const d=await sql(env,'SELECT * FROM hnd_delegations WHERE id=?',c.delegation_id).first<Delegation>()
 const l=d?await sql(env,'SELECT * FROM hnd_frontdesk_lines WHERE id=?',d.line_id).first<Line>():null
 if(!d||!l||d.revoked_at||c.expires_at<=Date.now()||l.revision!==c.line_revision)throw new Fault('executive_delegation_inactive',403)
 const policy=linePolicy(l)
 if(policy.dnd||!policy.withinHours||policy.forwardTo)throw new Fault('executive_line_policy_refused',403)
 const fences=[delegationFence(env,d.assistant_id,d,l),guard(env,`SELECT count(*) FROM hnd_frontdesk_controls c JOIN oa_operators o ON o.id=c.approved_by WHERE c.operation_id=? AND c.expires_at>? AND o.role='owner' AND o.status='active' AND o.version=c.owner_version`,c.operation_id,Date.now())]
 try{await env.DB.batch([...fences,sql(env,'DELETE FROM hnd_guard')])}catch{throw new Fault('executive_delegation_inactive',403)}
 return fences
}
