import type { Bindings } from '../../auth.server'

export const effectKinds = ['booking','deposit','refund','crm','support'] as const
type EffectKind = typeof effectKinds[number]
export interface ReceptionistWork {
 outcomeIds:string[]
 steps:{id:string;outcomeId:string;kind:EffectKind;state:string;externalId:string|null;observedAt:number;confirmed:boolean}[]
 exceptions:{id:string;outcomeId:string;kind:string;state:string;ownerId:string}[]
}
export async function receptionistSources(env:Bindings,capturedAt:number) {
 const [steps,exceptions]=await Promise.all([
  env.DB.prepare(`SELECT s.id,s.outcome_id,s.kind,s.state,s.external_id,s.updated_at,
   CASE WHEN s.state='confirmed' AND s.external_id IS NOT NULL AND s.readback IS NOT NULL THEN 1 ELSE 0 END AS confirmed
   FROM hnd_rx_steps s WHERE s.kind<>'availability' AND s.updated_at<=? ORDER BY s.id`).bind(capturedAt)
   .all<{id:string;outcome_id:string;kind:EffectKind;state:string;external_id:string|null;updated_at:number;confirmed:number}>(),
  env.DB.prepare('SELECT id,outcome_id,kind,status,owner_id FROM hnd_rx_exceptions WHERE created_at<=? ORDER BY id').bind(capturedAt)
   .all<{id:string;outcome_id:string;kind:string;status:string;owner_id:string}>(),
 ])
 return (outcomeIds:string[]):ReceptionistWork=>({outcomeIds,
  steps:steps.results.filter(s=>outcomeIds.includes(s.outcome_id)).map(s=>({id:s.id,outcomeId:s.outcome_id,kind:s.kind,state:s.state,externalId:s.external_id,observedAt:s.updated_at,confirmed:Boolean(s.confirmed)})),
  exceptions:exceptions.results.filter(x=>outcomeIds.includes(x.outcome_id)).map(x=>({id:x.id,outcomeId:x.outcome_id,kind:x.kind,state:x.status,ownerId:x.owner_id})),
 })
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
  basis:'Exact canonical call and case linkage. Confirmed effects require receiving-system readback and an external record identity. Availability reads are excluded. Each effect kind counts a customer call once; kinds and work states can overlap. CRM and support confirmation proves a recorded handoff, not human acceptance. An open outcome without an effect stays unstarted. No effect or agent-declared state certifies complete receptionist work, caller audio or customer resolution.',
 }
}
