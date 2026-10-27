import type { Bindings } from '../../auth.server'

export const effectKinds = ['booking','deposit','refund','crm','support'] as const
type EffectKind = typeof effectKinds[number]
export interface ReceptionistWork {
 outcomeIds:string[]
 steps:{id:string;outcomeId:string;kind:EffectKind;state:string;externalId:string|null;observedAt:number;revision:number;confirmed:boolean}[]
 exceptions:{id:string;outcomeId:string;kind:string;state:string;ownerId:string}[]
}
interface StepSource {id:string;outcome_id:string;kind:EffectKind;state:string;external_id:string|null;updated_at:number;version:number;confirmed:number}
interface OutcomeSource {id:string;call_id:string;case_id:string;created_at:number;human_assignment:number}
interface ExceptionSource {id:string;outcome_id:string;kind:string;status:string;owner_id:string}
export async function receptionistSources(env:Bindings,capturedAt:number) {
 // D1 batch reads one transaction snapshot. Capture identities and revisions,
 // rather than filtering mutable update timestamps against the request clock.
 const [stepRows,exceptionRows,outcomeRows]=await env.DB.batch([
  env.DB.prepare(`SELECT s.id,s.outcome_id,s.kind,s.state,s.external_id,s.updated_at,s.version,
   CASE WHEN s.state='confirmed' AND s.external_id IS NOT NULL AND s.readback IS NOT NULL THEN 1 ELSE 0 END AS confirmed
   FROM hnd_rx_steps s WHERE s.kind<>'availability' ORDER BY s.id`),
  env.DB.prepare('SELECT id,outcome_id,kind,status,owner_id FROM hnd_rx_exceptions ORDER BY id'),
  env.DB.prepare(`SELECT o.id,o.call_id,o.case_id,o.created_at,
   EXISTS(SELECT 1 FROM hnd_queue_entries e WHERE e.call_id=o.call_id AND e.agent_id IS NOT NULL) AS human_assignment
   FROM hnd_rx_outcomes o WHERE o.created_at<=?`).bind(capturedAt),
 ])
 const steps=stepRows.results as unknown as StepSource[],exceptions=exceptionRows.results as unknown as ExceptionSource[]
 const outcomes=(outcomeRows.results as unknown as OutcomeSource[]).map(o=>{
  const effects=steps.filter(s=>s.outcome_id===o.id),bookings=effects.filter(s=>s.kind==='booking'&&s.confirmed)
  return {...o,booked_at:bookings.length?Math.min(...bookings.map(s=>s.updated_at)):null,
   escalated:exceptions.some(x=>x.outcome_id===o.id),
   unfinished_or_handoff:effects.some(s=>['crm','support','refund'].includes(s.kind)||s.state!=='confirmed')}
 })
 const work=(outcomeIds:string[]):ReceptionistWork=>({outcomeIds,
  steps:steps.filter(s=>outcomeIds.includes(s.outcome_id)).map(s=>({id:s.id,outcomeId:s.outcome_id,kind:s.kind,state:s.state,externalId:s.external_id,observedAt:s.updated_at,revision:s.version,confirmed:Boolean(s.confirmed)})),
  exceptions:exceptions.filter(x=>outcomeIds.includes(x.outcome_id)).map(x=>({id:x.id,outcomeId:x.outcome_id,kind:x.kind,state:x.status,ownerId:x.owner_id})),
 })
 const linkedSteps=steps.filter(s=>outcomes.some(o=>o.id===s.outcome_id))
 return {outcomes,work,bookings:linkedSteps.filter(s=>s.kind==='booking'&&s.confirmed).map(s=>({id:s.id,case_id:outcomes.find(o=>o.id===s.outcome_id)!.case_id,updated_at:s.updated_at}))}
}
export function workStates(work:ReceptionistWork) {
 return {
  confirmed:work.steps.some(s=>s.confirmed),
  pending:work.steps.some(s=>!s.confirmed&&s.state!=='rejected'),
  rejected:work.steps.some(s=>s.state==='rejected'),
  escalated:work.exceptions.some(x=>x.state==='open'||x.state==='held'),
  unstarted:work.outcomeIds.length>0&&work.steps.length===0,
 }
}
export function receptionistSummary(calls:{id:string;receptionistWork:ReceptionistWork}[]) {
 const linked=calls.filter(c=>c.receptionistWork.outcomeIds.length)
 return {linkedCalls:linked.length,
  byKind:effectKinds.map(kind=>{
   const withSteps=linked.filter(c=>c.receptionistWork.steps.some(s=>s.kind===kind))
   const confirmed=withSteps.filter(c=>c.receptionistWork.steps.some(s=>s.kind===kind&&s.confirmed))
   return {kind,calls:withSteps.length,confirmedCalls:confirmed.length,sourceCallIds:withSteps.map(c=>c.id),confirmedCallIds:confirmed.map(c=>c.id)}
  }),
  states:Object.fromEntries((['confirmed','pending','rejected','escalated','unstarted'] as const).map(state=>[state,linked.filter(c=>workStates(c.receptionistWork)[state]).map(c=>c.id)])),
  basis:'Exact canonical call and case linkage. Confirmed effects require receiving-system readback and an external record identity. Saved reports retain captured effect revisions and states; subsequent edits appear in later reports. Availability reads are excluded. Each effect kind counts a customer call once; kinds and work states can overlap. CRM and support confirmation proves a recorded handoff, not human acceptance. An open outcome without an effect stays unstarted. No effect or agent-declared state certifies complete receptionist work, caller audio or customer resolution.',
 }
}
