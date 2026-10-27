import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, ownerFence } from '../core'
import { guard, nativeFence, sql } from '../delegation/store'
import type { FlowDefinition } from '../flows/definition'
import type { CustomRole } from './custom-roles'

export type FlowCapability='flow.read'|'flow.draft'|'flow.test'
const joined='FROM hnd_custom_roles r JOIN hnd_custom_role_members m ON m.role_id=r.id JOIN oa_operators p ON p.id=m.person_id JOIN oa_operators issuer ON issuer.id=r.created_by'
const live="p.status='active' AND p.role='member' AND p.version=m.person_version AND m.role_revision=r.revision AND issuer.status='active' AND issuer.role='owner' AND issuer.version=r.owner_version"
const scoped=`EXISTS(SELECT 1 FROM json_each(r.flow_ids) WHERE value=?) AND EXISTS(SELECT 1 FROM json_each(r.capabilities) WHERE value=?)`

export async function authorizeFlow(env:Bindings,actor:Session,flowId:string,capability:FlowCapability){
 if(actor.operator.role==='owner')return {fences:[ownerFence(env.DB,actor)],applied:{}}
 const role=await sql(env,`SELECT r.* ${joined} WHERE m.person_id=? AND ${live} AND ${scoped} ORDER BY r.id LIMIT 1`,actor.operator.id,flowId,capability).first<CustomRole>()
 if(!role)throw new Fault('flow_access_required',403)
 return {fences:[nativeFence(env,actor),guard(env,`SELECT count(*) ${joined} WHERE r.id=? AND r.revision=? AND m.person_id=? AND ${live} AND ${scoped}`,role.id,role.revision,actor.operator.id,flowId,capability)],applied:{access:{id:role.id,revision:role.revision,ownerVersion:role.owner_version}}}
}

export async function flowScope(env:Bindings,actor:Session){
 if(actor.operator.role==='owner')return null
 const result=await env.DB.batch([nativeFence(env,actor),sql(env,`SELECT DISTINCT f.value AS id ${joined} JOIN json_each(r.flow_ids) f WHERE m.person_id=? AND ${live} AND EXISTS(SELECT 1 FROM json_each(r.capabilities) WHERE value='flow.read') ORDER BY id`,actor.operator.id),sql(env,'DELETE FROM hnd_guard')])
 const scope=(result[1].results as unknown as {id:string}[]).map(r=>r.id)
 if(!scope.length)throw new Fault('flow_access_required',403)
 return scope
}

// A flow grant discloses only references already present in its retained versions.
// It cannot be used to attach another queue, person or prompt to that flow.
export function flowReferences(definitions:FlowDefinition[]){
 return {queues:[...new Set(definitions.flatMap(d=>d.nodes.flatMap(n=>n.queueId?[n.queueId]:[])))],people:[...new Set(definitions.flatMap(d=>d.nodes.flatMap(n=>n.group?.members??[])))],prompts:[...new Set(definitions.flatMap(d=>d.nodes.flatMap(n=>n.prompt?[n.prompt.promptId+':'+n.prompt.versionId]:[])))]}
}
export async function authorizeFlowDefinition(env:Bindings,actor:Session,flowId:string,d:FlowDefinition){
 if(actor.operator.role==='owner')return
 const rows=(await sql(env,'SELECT definition FROM hnd_flow_versions WHERE flow_id=?',flowId).all<{definition:string}>()).results
 const allowed=flowReferences(rows.map(row=>JSON.parse(row.definition) as FlowDefinition)),requested=flowReferences([d])
 if(requested.queues.some(id=>!allowed.queues.includes(id))||requested.people.some(id=>!allowed.people.includes(id))||requested.prompts.some(id=>!allowed.prompts.includes(id)))throw new Fault('flow_reference_out_of_scope',403)
}
