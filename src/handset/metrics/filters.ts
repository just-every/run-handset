import { choice, Fault, keys, object, text } from '../core'

export interface NativeFilters {
 hour?:string; person?:string; number?:string; team?:string; location?:string
 outcome?:'answered'|'missed'|'unknown'
}
const dimensions=['hour','person','number','team','location'] as const

export function parseNativeFilters(raw:unknown):NativeFilters {
 const value=object(raw);keys(value,[...dimensions,'outcome'])
 const filters:NativeFilters={}
 for(const key of dimensions)if(Object.hasOwn(value,key)){
  const selected=text(value[key],key)
  if(selected!==value[key])throw new Fault('invalid_'+key)
  filters[key]=selected
 }
 if(Object.hasOwn(value,'outcome'))filters.outcome=choice(value.outcome,['answered','missed','unknown'] as const,'outcome')
 return filters
}

export function matchesNativeFilters(call:Record<typeof dimensions[number],string>&{answered:boolean;missed:boolean},filters:NativeFilters):boolean {
 const outcome=call.answered?'answered':call.missed?'missed':'unknown'
 return dimensions.every(key=>filters[key]===undefined||call[key]===filters[key])&&(filters.outcome===undefined||outcome===filters.outcome)
}
