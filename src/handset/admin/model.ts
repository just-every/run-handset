import { Fault, choice, keys, object, text, type ObjectValue } from '../core'

export type ProfileKind = 'user'|'device'
export type Settings = Record<string,string>
export const settingKeys = ['hours','ringRules','keys','greeting'] as const
export const phoneRoles = ['member','greeting'] as const
export interface Profile {
 id:string; kind:ProfileKind; operator_id:string|null; record_id:string; identity:string; extension:string;
 config:string; overrides:string; template_id:string|null; template_version:number|null; version:number; updated_at:number
}
export interface Template {
 id:string; name:string; kind:ProfileKind; role_scope:string; settings:string; version:number; created_by:string; updated_at:number
}
export interface RowError { file:string; row:number; field:string; code:string }
export interface NativeOperator {id:string;version:number;status:string;role:string;email:string;display_name:string}
export interface PlanRow {
 file:string; row:number; id:string; kind:ProfileKind; operatorId:string|null; recordId:string;
 before:Profile|null; after:Settings; overrides:Settings; templateId:string|null; templateVersion:number|null;
 nativeBefore:NativeOperator|null; authorityTargets:NativeOperator[];
 changes:{field:string;before:string|null;after:string|null}[]; localCostCents:number; requiredApproval:string[]
}
export interface PlanSnapshot {
 rows:PlanRow[]; errors:RowError[]; catalogHash:string; templates:{id:string;version:number}[];
 cost:{currency:'USD';localConfigurationCents:number;providerCost:'unavailable';chargesAuthorized:false};
 heldEffects:string[]; policy:string
}
export interface Plan {
 id:string;kind:'csv'|'template';snapshot:string;hash:string;status:string;cursor:number;created_by:string;
 created_at:number;approved_by:string|null;approved_version:number|null;approved_role:string|null;approved_at:number|null;expires_at:number
}
export function settings(value:unknown):Settings {
 const v=object(value);keys(v,[...settingKeys])
 return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,text(v,k,k==='greeting'?2000:1000,true)]))
}
export function templateInput(v:ObjectValue) {
 keys(v,['name','kind','roleScope','settings','version'])
 if(!Array.isArray(v.roleScope)||v.roleScope.length<1||v.roleScope.length>2)throw new Fault('invalid_role_scope')
 const scope=[...new Set(v.roleScope.map(v=>choice(v,phoneRoles,'role_scope')))].sort()
 return {name:text(v.name,'name',100),kind:choice(v.kind,['user','device'],'kind'),roleScope:scope,settings:settings(v.settings)}
}
export function diff(before:Settings,after:Settings) {
 return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().filter(k=>before[k]!==after[k]).map(field=>({field,before:before[field]??null,after:after[field]??null}))
}
export function parseJson(value:unknown) {
 if(typeof value!=='string')return value
 try{return JSON.parse(value)}catch{throw new Fault('invalid_json_field')}
}
