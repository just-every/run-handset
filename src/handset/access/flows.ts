import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, ownerFence } from '../core'
import { guard, nativeFence, sql } from '../delegation/store'
import type { FlowDefinition } from '../flows/definition'
import type { CustomRole } from './custom-roles'

export type FlowCapability='flow.read'|'flow.draft'|'flow.test'
const joined='FROM hnd_custom_roles r JOIN hnd_custom_role_members m ON m.role_id=r.id JOIN oa_operators p ON p.id=m.person_id JOIN oa_operators issuer ON issuer.id=r.created_by'
const live="p.status='active' AND p.role='member' AND p.version=m.person_version AND m.role_revision=r.revision AND issuer.status='active' AND issuer.role='owner' AND issuer.version=r.owner_version"

// Read role authority once, then fence the exact selected revisions in each transaction.
export async function flowAccess(env:Bindings,actor:Session){
 const isOwner=actor.operator.role==='owner'
 const roles=isOwner?[]:(await sql(env,`SELECT r.* ${joined} WHERE m.person_id=? AND ${live} ORDER BY r.id`,actor.operator.id).all<CustomRole>()).results
 const grants=roles.map(role=>({role,flows:new Set(JSON.parse(role.flow_ids) as string[]),capabilities:new Set(JSON.parse(role.capabilities) as FlowCapability[])}))
 const selected=(flowId:string,capability:FlowCapability)=>grants.find(g=>g.flows.has(flowId)&&g.capabilities.has(capability))?.role
 const scope=isOwner?null:[...new Set(grants.filter(g=>g.capabilities.has('flow.read')).flatMap(g=>[...g.flows]))].sort()
 const allows=(flowId:string,capability:FlowCapability)=>isOwner||!!selected(flowId,capability)
 const permission=(flowIds:string[],capability:FlowCapability)=>{
  if(isOwner)return {fences:[ownerFence(env.DB,actor)],applied:{}}
  const targets=[...new Set(flowIds)].map(flow=>{
   const role=selected(flow,capability)
   if(!role)throw new Fault('flow_access_required',403)
   return {flow,role:role.id,revision:role.revision,ownerVersion:role.owner_version}
  })
  const first=targets[0]
  return {fences:[nativeFence(env,actor),guard(env,`SELECT NOT EXISTS(SELECT 1 FROM json_each(?) target WHERE NOT EXISTS(SELECT 1 ${joined} WHERE r.id=json_extract(target.value,'$.role') AND r.revision=json_extract(target.value,'$.revision') AND m.person_id=? AND ${live} AND EXISTS(SELECT 1 FROM json_each(r.flow_ids) WHERE value=json_extract(target.value,'$.flow')) AND EXISTS(SELECT 1 FROM json_each(r.capabilities) WHERE value=?)))`,JSON.stringify(targets),actor.operator.id,capability)],applied:first?{access:{id:first.role,revision:first.revision,ownerVersion:first.ownerVersion}}:{}}
 }
 return {scope,allows,permission}
}
export async function authorizeFlow(env:Bindings,actor:Session,flowId:string,capability:FlowCapability){
 return (await flowAccess(env,actor)).permission([flowId],capability)
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
