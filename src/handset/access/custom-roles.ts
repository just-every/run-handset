import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, id, integer, keys, owner, ownerFence, text, type ObjectValue } from '../core'
import { guard, nativeFence, sql } from '../delegation/store'

export interface CustomRole { id:string; revision:number; name:string; capabilities:string; prompt_ids:string; created_by:string; owner_version:number }
const live=`p.status='active' AND p.role='member' AND p.version=m.person_version
 AND m.role_revision=r.revision AND issuer.status='active' AND issuer.role='owner' AND issuer.version=r.owner_version`
const joined='FROM hnd_custom_roles r JOIN hnd_custom_role_members m ON m.role_id=r.id JOIN oa_operators p ON p.id=m.person_id JOIN oa_operators issuer ON issuer.id=r.created_by'
const capability=`EXISTS(SELECT 1 FROM json_each(r.capabilities) WHERE value='greeting.draft')`
const scope=`EXISTS(SELECT 1 FROM json_each(r.prompt_ids) WHERE value=?)`

export async function authorizePrompt(env:Bindings,actor:Session,promptId:string){
 if(actor.operator.role==='owner')return {fences:[ownerFence(env.DB,actor)],applied:{}}
 const role=await sql(env,`SELECT r.* ${joined} WHERE m.person_id=? AND ${live} AND ${capability} AND ${scope} ORDER BY r.id LIMIT 1`,actor.operator.id,promptId).first<CustomRole>()
 if(!role)throw new Fault('greeting_access_required',403)
 return {fences:[nativeFence(env,actor),guard(env,`SELECT count(*) ${joined} WHERE r.id=? AND r.revision=? AND m.person_id=? AND ${live} AND ${capability} AND ${scope}`,role.id,role.revision,actor.operator.id,promptId)],applied:{access:{id:role.id,revision:role.revision,ownerVersion:role.owner_version}}}
}

export async function promptScope(env:Bindings,actor:Session){
 if(actor.operator.role==='owner')return null
 const result=await env.DB.batch([nativeFence(env,actor),sql(env,`SELECT DISTINCT prompts.id ${joined} JOIN hnd_prompts prompts ON EXISTS(SELECT 1 FROM json_each(r.prompt_ids) WHERE value=prompts.id) WHERE m.person_id=? AND ${live} AND ${capability} ORDER BY prompts.id`,actor.operator.id),sql(env,'DELETE FROM hnd_guard')])
 return (result[1].results as unknown as {id:string}[]).map(p=>p.id)
}

export async function roleSnapshot(env:Bindings,actor:Session){
 owner(actor)
 const result=await env.DB.batch([ownerFence(env.DB,actor),
  sql(env,'SELECT * FROM hnd_custom_roles ORDER BY created_at,id'),
  sql(env,`SELECT m.*,p.display_name,CASE WHEN ${live} THEN 'active' ELSE 'suspended' END AS state ${joined} ORDER BY p.display_name`),
  sql(env,"SELECT id,version,display_name FROM oa_operators WHERE role='member' AND status='active' ORDER BY display_name,id"),
  sql(env,'SELECT id,name FROM hnd_prompts ORDER BY name,id'),sql(env,'DELETE FROM hnd_guard')])
 return {roles:result[1].results as unknown as CustomRole[],members:result[2].results as unknown as {role_id:string;person_id:string;display_name:string;state:string}[],people:result[3].results as unknown as {id:string;version:number;display_name:string}[],prompts:result[4].results as unknown as {id:string;name:string}[]}
}

export async function saveRole(env:Bindings,actor:Session,v:ObjectValue,roleId?:string){
 owner(actor);keys(v,['revision','name','capabilities','promptIds','confirm'])
 if(v.confirm!=='approve greeting draft role')throw new Fault('exact_role_approval_required',403)
 const revision=integer(v.revision,'revision',0),name=text(v.name,'name',80)
 if(!Array.isArray(v.capabilities)||v.capabilities.some(c=>c!=='greeting.draft')||new Set(v.capabilities).size!==v.capabilities.length)throw new Fault('unsupported_role_capability',403)
 if(!Array.isArray(v.promptIds)||!v.promptIds.length||v.promptIds.length>100||new Set(v.promptIds).size!==v.promptIds.length)throw new Fault('exact_prompt_scope_required')
 const prompts=v.promptIds.map(p=>text(p,'promptId',36)),target=roleId??id()
 if(!roleId&&revision!==0)throw new Fault('role_revision_changed',409)
 const current=roleId?await sql(env,'SELECT revision FROM hnd_custom_roles WHERE id=?',target).first<{revision:number}>():null
 if(roleId&&current?.revision!==revision)throw new Fault('role_revision_changed',409)
 await commit(env,actor,'scope.grant',target,'completed',[
  ...(roleId?[guard(env,'SELECT count(*) FROM hnd_custom_roles WHERE id=? AND revision=?',target,revision)]:[]),
  ...prompts.map(p=>guard(env,'SELECT count(*) FROM hnd_prompts WHERE id=?',p)),
  sql(env,'INSERT INTO hnd_custom_roles VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,name=excluded.name,capabilities=excluded.capabilities,prompt_ids=excluded.prompt_ids,created_by=excluded.created_by,owner_version=excluded.owner_version',target,revision+1,name,JSON.stringify(v.capabilities),JSON.stringify(prompts),actor.operator.id,actor.operator.version,Date.now()),
 ],true,{access:{id:target,revision:revision+1,ownerVersion:actor.operator.version}})
 return {id:target,revision:revision+1,name,capabilities:v.capabilities,promptIds:prompts}
}

export async function assignRole(env:Bindings,actor:Session,v:ObjectValue,roleId:string){
 owner(actor);keys(v,['revision','personId','personVersion','confirm'])
 if(v.confirm!=='assign exact greeting role')throw new Fault('exact_role_assignment_required',403)
 const revision=integer(v.revision,'revision',1),person=text(v.personId,'personId'),version=integer(v.personVersion,'personVersion',1)
 await commit(env,actor,'scope.grant',roleId,'completed',[
  guard(env,'SELECT count(*) FROM hnd_custom_roles WHERE id=? AND revision=? AND created_by=? AND owner_version=?',roleId,revision,actor.operator.id,actor.operator.version),
  guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND role='member' AND status='active'",person,version),
  sql(env,'INSERT INTO hnd_custom_role_members VALUES (?,?,?,?) ON CONFLICT(role_id,person_id) DO UPDATE SET person_version=excluded.person_version,role_revision=excluded.role_revision',roleId,person,version,revision),
 ])
 return {assigned:true}
}
