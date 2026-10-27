import { escape as e } from '../core'
import type { NativeFilters } from './filters'
import type { receptionistSummary, ReceptionistWork } from './receptionist'

const callCount=(count:number)=>`${count} ${count===1?'call':'calls'}`
const names={booking:'Booking',deposit:'Deposit',refund:'Refund',crm:'CRM handoff',support:'Support handoff'}
export function receptionistBody(summary:ReturnType<typeof receptionistSummary>|undefined,filters:NativeFilters,link?:((filters:NativeFilters,label:string)=>string)) {
 if(!summary)return ''
 return `<details><summary>Receptionist execution</summary><p>${e(summary.basis)}</p><p>${callCount(summary.linkedCalls)} with linked receptionist work.</p><dl>${summary.byKind.map(row=>`<dt>${names[row.kind]}</dt><dd>${row.confirmedCalls} confirmed of ${callCount(row.calls)} with this effect</dd>`).join('')}</dl><ul>${Object.entries(summary.states).map(([state,ids])=>`<li>${link?link({...filters,receptionistState:state as NativeFilters['receptionistState']},'Show '+state+' receptionist work'):e(state)}: ${callCount(ids.length)}</li>`).join('')}</ul></details>`
}
export function receptionistSource(work:ReceptionistWork|undefined) {
 if(!work?.outcomeIds.length)return ''
 return `<details><summary>Receptionist source work</summary><ul>${work.steps.map(s=>`<li>${e(names[s.kind])} · ${e(s.state)} · Step ${e(s.id)} · Outcome ${e(s.outcomeId)} · ${s.confirmed?'Readback confirmed':'Not confirmed'}${s.externalId?' · External record '+e(s.externalId):''} · ${e(new Date(s.observedAt).toISOString())}</li>`).join('')||'<li>No business effect recorded.</li>'}${work.exceptions.map(x=>`<li>${e(x.kind)} · ${e(x.state)} · Exception ${e(x.id)} · Owner ${e(x.ownerId)}</li>`).join('')}</ul></details>`
}
