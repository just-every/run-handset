import { choice, Fault, keys, object, text } from '../core'
import { workStates, type ReceptionistWork } from './receptionist'

export interface NativeFilters {
 hour?:string; person?:string; number?:string; team?:string; location?:string; handlingUser?:string; trackingSource?:string
 outcome?:'answered'|'missed'|'unknown'
 receptionistState?:'confirmed'|'pending'|'rejected'|'escalated'|'unstarted'
}
const dimensions=['hour','person','number','team','location','trackingSource'] as const

export function parseNativeFilters(raw:unknown):NativeFilters {
 const value=object(raw);keys(value,[...dimensions,'handlingUser','outcome','receptionistState'])
 const filters:NativeFilters={}
 for(const key of [...dimensions,'handlingUser'] as const)if(Object.hasOwn(value,key)){
  const selected=text(value[key],key)
  if(selected!==value[key])throw new Fault('invalid_'+key)
  filters[key]=selected
 }
 if(Object.hasOwn(value,'outcome'))filters.outcome=choice(value.outcome,['answered','missed','unknown'] as const,'outcome')
 if(Object.hasOwn(value,'receptionistState'))filters.receptionistState=choice(value.receptionistState,['confirmed','pending','rejected','escalated','unstarted'] as const,'receptionistState')
 return filters
}

export function matchesNativeFilters(call:Record<typeof dimensions[number],string>&{answered:boolean;missed:boolean;handlingUsers:string[];receptionistWork:ReceptionistWork},filters:NativeFilters):boolean {
 const outcome=call.answered?'answered':call.missed?'missed':'unknown'
 return dimensions.every(key=>filters[key]===undefined||call[key]===filters[key])&&(filters.handlingUser===undefined||(call.handlingUsers.length?call.handlingUsers:['Unattributed']).includes(filters.handlingUser))&&(filters.outcome===undefined||outcome===filters.outcome)&&(filters.receptionistState===undefined||workStates(call.receptionistWork)[filters.receptionistState])
}
