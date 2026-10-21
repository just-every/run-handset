import { escape as e, field, id } from '../core'
import { modes } from './model'
import type { NativeOptions } from './read'

export type Option=[string,string]
export const form=(path:string,body:string,label:string)=>`<form method="post" action="/app/dialer/${e(path)}">${body}<button>${e(label)}</button></form>`
export function select(label:string,name:string,options:Option[],required=true) {
 const control=id()
 return `<label for="${control}">${e(label)}</label><select id="${control}" name="${e(name)}" ${required?'required':''}><option value="">${required?'Choose explicitly':'None selected'}</option>${options.map(([value,label])=>`<option value="${e(value)}">${e(label)}</option>`).join('')}</select>`
}
export function area(label:string,name:string,max=1000) {
 const control=id()
 return `<label for="${control}">${e(label)}</label><textarea id="${control}" name="${e(name)}" rows="3" maxlength="${max}" required></textarea>`
}
export const confirm=(value:string,label:string)=>`<label><input type="checkbox" name="confirm" value="${e(value)}" required>${e(label)}</label>`
export const number=(label:string,name:string,min:number,max:number)=>`<label>${e(label)}<input type="number" name="${e(name)}" min="${min}" max="${max}" step="1" required></label>`
export const utc=(label:string,name:string)=>field(label+' (UTC)',name,'','datetime-local',true,'1')
export const modeChoices=(allowed:readonly string[]=modes)=>`<fieldset><legend>Explicitly permitted dialing modes</legend>${allowed.map(m=>`<label><input type="checkbox" name="mode.${e(m)}" value="selected">${e(m[0].toUpperCase()+m.slice(1))}</label>`).join('')}<p>Select only modes covered by the evidence and approval. No mode is selected automatically.</p></fieldset>`
export const sourceOptions=(o:NativeOptions):Option[]=>o.sources.map(s=>[s.id,`${s.e164} · Account ${s.account_id} · Source ${s.id}`])
export const operatorOptions=(o:NativeOptions):Option[]=>o.operators.map(p=>[p.id,p.display_name])
export const evidenceOptions=(o:NativeOptions):Option[]=>o.evidence.map(r=>[r.id,`${r.kind} · ${r.case_title??'Installation evidence'} · ${r.summary} · ${r.id}`])
export const sourceName=(o:NativeOptions,sourceId:unknown)=>{const s=o.sources.find(s=>s.id===sourceId);return s?`${s.e164} · ${s.id}`:String(sourceId)}
export const time=(label:string,name:string,min:string,max:string)=>`<label>${e(label)}<input type="time" name="${e(name)}" min="${min}" max="${max}" step="60" required></label>`
