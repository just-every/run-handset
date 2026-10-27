import type { Bindings } from '../../auth.server'
import { Fault } from '../core'
import { activeSourceById, sourceFence } from '../providers/sources'
import { guard } from '../consent/store'
import type { Thread, MessageJob } from './model'
export const groupThreadQuery=`SELECT t.id FROM hnd_message_threads t WHERE t.id=? AND (t.route_kind='programmable' OR EXISTS(SELECT 1 FROM hnd_message_group_routes g JOIN oa_operators o ON o.id=g.approved_by WHERE g.source_id=t.source_id AND t.peer='group:'||g.conversation_sid AND g.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=g.owner_version))`
export const groupThreadFence=(env:Bindings,key:string)=>guard(env,'SELECT count(*) FROM ('+groupThreadQuery+')',key)
export async function thread(env:Bindings,key:string) {
 const row=await env.DB.prepare('SELECT * FROM hnd_message_threads WHERE id=?').bind(key).first<Thread>()
 if(!row)throw new Fault('thread_not_found',404)
 if(row.route_kind==='conversations'&&!await env.DB.prepare(groupThreadQuery).bind(row.id).first())throw new Fault('group_source_not_authorized',403)
 const source=await activeSourceById(env,row.source_id)
 if(!source||source.e164!==row.business)throw new Fault('message_source_inactive',409)
 return {row,source}
}
export async function job(env:Bindings,key:string) {
 const row=await env.DB.prepare('SELECT * FROM hnd_message_jobs WHERE id=?').bind(key).first<MessageJob>()
 if(!row)throw new Fault('message_not_found',404)
 return row
}
export const custodyFence=(env:Bindings,t:Thread,actorId:string)=>guard(env,"SELECT count(*) FROM hnd_message_threads WHERE id=? AND revision=? AND owner_id=? AND custody='handset'",t.id,t.revision,actorId)
export async function permission(env:Bindings,key:string,recipient:string) {
 const row=await env.DB.prepare(`SELECT p.* FROM hnd_message_permissions p JOIN oa_operators o ON o.id=p.approved_by WHERE p.id=? AND p.recipient=? AND p.revoked_at IS NULL AND p.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=p.owner_version`).bind(key,recipient,Date.now()).first<{id:string;recipient:string}>()
 if(!row)throw new Fault('explicit_customer_care_permission_required',403)
 return row
}
export const permissionFence=(env:Bindings,key:string,recipient:string)=>guard(env,`SELECT count(*) FROM hnd_message_permissions p JOIN oa_operators o ON o.id=p.approved_by WHERE p.id=? AND p.recipient=? AND p.revoked_at IS NULL AND p.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=p.owner_version`,key,recipient,Date.now())
export {sourceFence}
