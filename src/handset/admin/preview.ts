import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, digest, id, keys, policy, text, type ObjectValue } from '../core'
import { csv } from './csv'
import { diff, settingKeys, type PlanRow, type ProfileKind, type RowError, type Settings } from './model'
import { catalog, emptyCost, heldEffects, savePlan } from './store'
import { mayManage } from './access'

export async function previewCsv(env:Bindings,actor:Session,value:ObjectValue) {
 keys(value,['usersCsv','devicesCsv'])
 const parsed=[csv(value.usersCsv,'user'),csv(value.devicesCsv,'device')],errors:RowError[]=parsed.flatMap(p=>p.errors),source=parsed.flatMap(p=>p.rows)
 if(!source.length)throw new Fault('empty_csv')
 if(source.length>200)throw new Fault('csv_row_limit')
 const current=await catalog(env.DB),rows:PlanRow[]=[],seen=new Map<string,typeof source[number]>()
 const issue=(file:string,row:number,field:string,code:string)=>errors.push({file,row,field,code})
 for(const r of source){
  const v=r.values,kind:ProfileKind=r.file
  for(const [k,val] of Object.entries(v))try{text(val,k,k==='greeting'?2000:1000,true)}catch{issue(kind,r.row,k,'invalid_value')}
  const identity=kind==='user'?(v.email??'').toLowerCase():(v.mac??'').replace(/[:-]/g,'').toUpperCase()
  if(kind==='user'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity))issue(kind,r.row,'email','invalid_email')
  if(kind==='device'&&!/^[0-9A-F]{12}$/.test(identity))issue(kind,r.row,'mac','invalid_mac')
  for(const field of ['name','location','emergencyAddress'])if(!v[field])issue(kind,r.row,field,'required')
  if(!/^\d{2,8}$/.test(v.extension??''))issue(kind,r.row,'extension','invalid_extension')
  if(v.role&&!['member','greeting'].includes(v.role))issue(kind,r.row,'role','role_grant_requires_separate_authority')
  const before=current.profiles.find(p=>p.kind===kind&&p.identity===identity)??null,old:Settings=before?JSON.parse(before.config):{}
  const after:Settings={...old,...v,role:kind==='user'?(v.role||old.role||'member'):'member'}
  if(kind==='user')after.email=identity;else after.mac=identity
  for(const field of settingKeys)if(!v[field]){if(field in old)after[field]=old[field];else delete after[field]}
  after.numberId=v.numberId||old.numberId||'';after.queues=v.queues??old.queues??''
  if(after.numberId&&!current.numbers.some(n=>n.id===after.numberId))issue(kind,r.row,'numberId','native_number_not_found')
  const reused=current.profiles.find(p=>p.extension===after.extension&&p.id!==before?.id)
  if(reused)issue(kind,r.row,'extension','extension_in_use')
  for(const [field,key] of [['identity',kind+':'+identity],['extension','extension:'+after.extension]]){
   const previous=seen.get(key)
   if(previous){issue(kind,r.row,field==='identity'?(kind==='user'?'email':'mac'):field,'duplicate');issue(previous.file,previous.row,field==='identity'?(kind==='user'?'email':'mac'):field,'duplicate')}
   else seen.set(key,r)
  }
  const native=kind==='user'?current.operators.find(o=>o.email.toLowerCase()===identity)??null:null
  const authorityTargets=current.operators.filter(o=>o.id===native?.id||(kind==='device'&&[old.userEmail?.toLowerCase(),after.userEmail?.toLowerCase()].includes(o.email.toLowerCase())))
  if(!mayManage(actor,authorityTargets))issue(kind,r.row,'role','elevated_target_protected')
  const overrides:Settings=before?JSON.parse(before.overrides):{}
  for(const field of settingKeys)if(v[field])overrides[field]=v[field]
  const ordered=Object.fromEntries(Object.entries(after).sort(([a],[b])=>a.localeCompare(b)))
  const nativeChanged=before&&(old.name!==after.name||(kind==='device'&&(old.userEmail??'')!==(after.userEmail??'')))
  rows.push({file:kind,row:r.row,id:before?.id??id(),kind,operatorId:kind==='user'?(before?.operator_id??native?.id??id()):null,recordId:nativeChanged?id():(before?.record_id??id()),before,after:ordered,overrides,templateId:before?.template_id??null,templateVersion:before?.template_version??null,nativeBefore:native,authorityTargets,changes:diff(old,ordered),localCostCents:0,requiredApproval:['Exact reviewed local configuration',...(kind==='user'&&!native?['Separate invitation approval; account has no admission credential']:[]),...(after.numberId?['Separate live number assignment authority']:[])]})
 }
 for(const row of rows)if(row.kind==='device'&&row.after.userEmail){
  row.after.userEmail=row.after.userEmail.toLowerCase()
  if(!current.profiles.some(p=>p.kind==='user'&&p.identity===row.after.userEmail)&&!rows.some(r=>r.kind==='user'&&r.after.email===row.after.userEmail))issue(row.kind,row.row,'userEmail','user_not_found')
 }
 return savePlan(env,actor,'csv',{rows,errors,catalogHash:await digest(current),templates:[],cost:emptyCost(),heldEffects:[...heldEffects],policy})
}
