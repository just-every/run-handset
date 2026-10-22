import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { adminCommit as commit } from './access'
import { Fault, digest, id, integer, keys, policy, text, type ObjectValue } from '../core'
import { diff, settings, templateInput, type PlanRow, type RowError, type Settings } from './model'
import { catalog, emptyCost, getProfile, getTemplate, heldEffects, savePlan } from './store'
import { mayManage, profileTargets, targetFences } from './access'

export async function writeTemplate(env:Bindings,actor:Session,value:ObjectValue,templateId?:string) {
 const v=templateInput(value),target=templateId??id(),now=Date.now(),db=env.DB
 const statements:D1PreparedStatement[]=[]
 if(templateId){
  const before=await getTemplate(db,target),version=integer(value.version,'version',1)
  if(before.version!==version)throw new Fault('template_version_conflict',409)
  if(before.kind!==v.kind)throw new Fault('template_kind_immutable',409)
  statements.push(db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_admin_templates WHERE id=? AND version=?').bind(target,version),db.prepare('UPDATE hnd_admin_templates SET name=?,role_scope=?,settings=?,version=version+1,created_by=?,updated_at=? WHERE id=?').bind(v.name,JSON.stringify(v.roleScope),JSON.stringify(v.settings),actor.operator.id,now,target))
 }else{
  if(value.version!==undefined)throw new Fault('unexpected_template_version')
  statements.push(db.prepare('INSERT INTO hnd_admin_templates VALUES (?,?,?,?,?,1,?,?)').bind(target,v.name,v.kind,JSON.stringify(v.roleScope),JSON.stringify(v.settings),actor.operator.id,now))
 }
 await commit(env,actor,templateId?'template.revise':'template.create',target,'completed',statements)
 return getTemplate(db,target)
}
export async function previewTemplate(env:Bindings,actor:Session,templateId:string,value:ObjectValue) {
 keys(value,['version','profileIds'])
 const template=await getTemplate(env.DB,templateId),version=integer(value.version,'version',1)
 if(template.version!==version)throw new Fault('template_version_conflict',409)
 if(!Array.isArray(value.profileIds)||!value.profileIds.length||value.profileIds.length>200)throw new Fault('explicit_profiles_required')
 const selected=value.profileIds.map(v=>text(v,'profileId'))
 if(new Set(selected).size!==selected.length)throw new Fault('duplicate_profile')
 const current=await catalog(env.DB),rows:PlanRow[]=[],errors:RowError[]=[],scope=JSON.parse(template.role_scope) as string[],settingValues=JSON.parse(template.settings) as Settings
 for(const [index,profileId] of selected.entries()){
  const p=current.profiles.find(p=>p.id===profileId)
  if(!p)throw new Fault('profile_not_found',404)
  const old=JSON.parse(p.config) as Settings,overrides=JSON.parse(p.overrides) as Settings
  const authorityTargets=current.operators.filter(o=>o.id===p.operator_id||(p.kind==='device'&&o.email.toLowerCase()===old.userEmail?.toLowerCase()))
  if(!mayManage(actor,authorityTargets))errors.push({file:'template',row:index+1,field:'profileId',code:'elevated_target_protected'})
  if(p.kind!==template.kind||!scope.includes(old.role))errors.push({file:'template',row:index+1,field:'profileId',code:'template_scope_refused'})
  const after={...old,...settingValues,...overrides}
  rows.push({file:'template',row:index+1,id:p.id,kind:p.kind,operatorId:p.operator_id,recordId:p.record_id,before:p,after,overrides,templateId:template.id,templateVersion:version,nativeBefore:current.operators.find(o=>o.id===p.operator_id)??null,authorityTargets,changes:diff(old,after),localCostCents:0,requiredApproval:['Exact selected records and template revision','Separate authority before any live routing activation']})
 }
 return savePlan(env,actor,'template',{rows,errors,catalogHash:await digest(current),templates:[{id:template.id,version}],cost:emptyCost(),heldEffects:[...heldEffects],policy})
}
export async function writeOverride(env:Bindings,actor:Session,profileId:string,value:ObjectValue) {
 keys(value,['version','settings'])
 const profile=await getProfile(env.DB,profileId),expected=integer(value.version,'version',1),v=settings(value.settings)
 if(profile.version!==expected)throw new Fault('profile_version_conflict',409)
 if(!Object.keys(v).length)throw new Fault('empty_override')
 const config={...JSON.parse(profile.config),...v},overrides={...JSON.parse(profile.overrides),...v}
 const targets=await profileTargets(env.DB,profile.operator_id,config.userEmail)
 await commit(env,actor,'admin.override',profile.id,'completed',[
  ...targetFences(env.DB,actor,targets),
  env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_admin_profiles WHERE id=? AND version=?').bind(profile.id,expected),
  env.DB.prepare('UPDATE hnd_admin_profiles SET config=?,overrides=?,version=version+1,updated_at=? WHERE id=?').bind(JSON.stringify(config),JSON.stringify(overrides),Date.now(),profile.id),
 ])
 return getProfile(env.DB,profileId)
}
