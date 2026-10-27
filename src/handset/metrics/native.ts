import type { Bindings } from '../../auth.server'
import type { Config } from './model'
import { callRows } from '../exports/logs'
import { matchesNativeFilters, parseNativeFilters, type NativeFilters } from './filters'
import { listGroups } from './groups'
import { handlingSources, containmentBasis, conversionBasis } from './call-outcomes'
import { receptionistSources, receptionistSummary, workStates } from './receptionist'

// Canonical customer calls are counted once, independently of endpoint offers.
export async function nativeAnalytics(env:Bindings,config:Config,rawFilters:NativeFilters={},reviewedCallIds:string[]=[]) {
 const filters=parseNativeFilters(rawFilters),capturedAt=Date.now()
 const [rows,assignments,handlers,receptionist]=await Promise.all([
  callRows(env,{from:config.startAt,to:config.endAt,timezone:config.timezone,queueId:null,ownerId:null},capturedAt),
  listGroups(env.DB),
  handlingSources(env,capturedAt),
  receptionistSources(env,capturedAt),
 ])
 const outcomeSources={handlers,outcomes:receptionist.outcomes},receptionistWork=receptionist.work
 const groups=new Map(assignments.map(assignment=>[assignment.number,assignment]))
 const queueCalls=new Set(config.queueId==='*'?[]:(await env.DB.prepare('SELECT DISTINCT e.call_id FROM hnd_queue_entries e JOIN hnd_queue_visits v ON v.entry_id=e.id WHERE v.queue_id=?').bind(config.queueId).all<{call_id:string}>()).results.map(e=>e.call_id))
 for(const callId of reviewedCallIds)queueCalls.add(callId)
 const roots=new Map(rows.filter(r=>r.kind==='call_session'&&(config.queueId==='*'||queueCalls.has(r.id))).map(r=>[r.id,r]))
 const allSourceCalls=[...roots.values()].map(r=>{
  const data=JSON.parse(r.data),status=r.status_data?JSON.parse(r.status_data):data
  const legs=rows.filter(leg=>leg.call_id===r.id)
  const statuses=legs.map(leg=>leg.provider_status??(leg.status_data?JSON.parse(leg.status_data):JSON.parse(leg.data)).providerStatus)
  const answered=statuses.some(s=>['completed','in-progress'].includes(s))
  const missed=!answered&&['no-answer','busy','failed','canceled'].includes(status.providerStatus)
  const hour=new Intl.DateTimeFormat('en-CA',{timeZone:config.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'}).format(r.occurred_at)
  const number=String(data.to??'Unknown'),assignment=groups.get(number)
  const handlers=outcomeSources.handlers.filter(h=>h.call_id===r.id)
  const outcomes=outcomeSources.outcomes.filter(o=>o.call_id===r.id&&o.case_id===r.case_id)
  const inbound=data.direction==='inbound',terminal=['completed','no-answer','busy','failed','canceled'].includes(status.providerStatus)
  const knownIdentity=/^\+[1-9]\d{7,14}$/.test(data.from??'')&&/^\+[1-9]\d{7,14}$/.test(data.to??'')
  const mature=r.occurred_at+config.repeatWindowHours*3600000<=capturedAt
  const booked=outcomes.some(o=>o.booked_at!==null&&o.booked_at>=r.occurred_at&&o.booked_at<=r.occurred_at+config.repeatWindowHours*3600000)
  const contained=inbound&&status.providerStatus==='completed'&&booked&&handlers.length===0&&outcomes.every(o=>!o.escalated&&!o.unfinished_or_handoff&&!o.human_assignment)
  return {id:r.id,caseId:r.case_id,occurredAt:r.occurred_at,hour,person:r.owner_id??'Unassigned',number,team:assignment?.team??'Unassigned',location:assignment?.location??'Unassigned',groupRevision:assignment?.revision??0,trackingSource:assignment?.trackingSource??'Unattributed',handlingUsers:[...new Set(handlers.map(h=>h.agent_id))].sort(),handlingOffers:handlers,
   receptionistWork:receptionistWork(outcomes.map(o=>o.id)),receptionistOutcomeIds:outcomes.map(o=>o.id),receptionistEligible:inbound&&terminal&&outcomes.length>0,contained,converted:inbound&&knownIdentity&&mature&&booked,conversionEligible:inbound&&knownIdentity&&mature&&assignment?.trackingSource!==undefined&&assignment.trackingSource!=='Unattributed',inbound,terminal,mature,knownIdentity,status:String(status.providerStatus??'unknown'),answered,missed}
 }).sort((a,b)=>a.occurredAt-b.occurredAt||a.id.localeCompare(b.id))
 const sourceCalls=allSourceCalls.filter(call=>matchesNativeFilters(call,filters))
 const caseIds=new Set(sourceCalls.map(c=>c.caseId)),callIds=new Set(sourceCalls.map(c=>c.id))
 const recoveries=(await env.DB.prepare('SELECT id,case_id,state,resolution FROM hnd_recovery').all<{id:string;case_id:string;state:string;resolution:string|null}>()).results.filter(r=>caseIds.has(r.case_id)).map(r=>{
  const resolution=r.resolution?JSON.parse(r.resolution):null
  const confirmed=receptionist.bookings.some(s=>s.id===resolution?.stepId&&s.case_id===r.case_id)
  return {...r,confirmed_step_id:confirmed?resolution.stepId:null}
 })
 const surveys=(await env.DB.prepare(`SELECT i.call_record_id,i.eligible_at,r.rating FROM hnd_survey_invitations i LEFT JOIN hnd_survey_responses r ON r.invitation_id=i.id`).all<{call_record_id:string;eligible_at:number|null;rating:number|null}>()).results.filter(i=>callIds.has(i.call_record_id))
 const ratings=surveys.filter(i=>i.rating!==null),delivered=surveys.filter(i=>i.eligible_at!==null).length
 const windowMs=config.repeatWindowHours*3600000
 const contacts=(await env.DB.prepare(`SELECT r.id,r.case_id,r.occurred_at,r.data,p.source_id FROM hnd_records r JOIN hnd_record_sources p ON p.record_id=r.id AND p.source_kind='twilio'
  WHERE r.kind='call_session' AND r.occurred_at>=? AND r.occurred_at<? AND r.received_at<=? AND json_extract(r.data,'$.direction')='inbound'
  AND NOT EXISTS(SELECT 1 FROM hnd_records n WHERE n.supersedes_id=r.id)`).bind(Math.max(0,config.startAt-windowMs),config.endAt+windowMs,capturedAt).all<{id:string;case_id:string|null;occurred_at:number;data:string;source_id:string}>()).results.map(c=>{const d=JSON.parse(c.data);return {...c,identity:/^\+[1-9]\d{7,14}$/.test(d.from??'')&&/^\+[1-9]\d{7,14}$/.test(d.to??'')?JSON.stringify([c.source_id,d.from,d.to]):null}})
 const bookings=receptionist.bookings
 const eligibleCallIds:string[]=[],resolvedCallIds:string[]=[],repeatCallIds:string[]=[],excluded={immature:0,unknownIdentity:0,repeatContact:0}
 for(const call of sourceCalls){
  const c=contacts.find(c=>c.id===call.id)
  if(!c?.identity){excluded.unknownIdentity++;continue}
  if(contacts.some(p=>p.identity===c.identity&&p.id!==c.id&&(p.occurred_at<c.occurred_at||p.occurred_at===c.occurred_at&&p.id<c.id)&&p.occurred_at>=c.occurred_at-windowMs)){excluded.repeatContact++;continue}
  if(c.occurred_at+windowMs>capturedAt){excluded.immature++;continue}
  eligibleCallIds.push(c.id)
  const repeated=contacts.some(n=>n.identity===c.identity&&n.id!==c.id&&n.occurred_at>=c.occurred_at&&n.occurred_at<=c.occurred_at+windowMs)
  if(repeated)repeatCallIds.push(c.id)
  if(!repeated&&bookings.some(b=>b.case_id===c.case_id&&b.updated_at>=c.occurred_at&&b.updated_at<=c.occurred_at+windowMs))resolvedCallIds.push(c.id)
 }
 const fcr={numerator:resolvedCallIds.length,denominator:eligibleCallIds.length,value:eligibleCallIds.length?resolvedCallIds.length/eligibleCallIds.length:null,windowHours:config.repeatWindowHours,eligibleCallIds,resolvedCallIds,repeatCallIds,excluded,basis:`First inbound contact per verified source, caller and business number after ${config.repeatWindowHours} quiet hours. Requires a complete ${config.repeatWindowHours}-hour observation window, independently read-back same-case booking within that window, and no repeat contact within it. Unknown identities, immature windows and subsequent repeat contacts are excluded. No inferred sentiment or manual closed flag counts as resolution.`}
 const group=(key:'hour'|'person'|'number'|'team'|'location'|'trackingSource'|'handlingUser')=>{
  const labels=(c:typeof sourceCalls[number])=>key==='handlingUser'?(c.handlingUsers.length?c.handlingUsers:['Unattributed']):[c[key]]
  return [...new Set(sourceCalls.flatMap(labels))].sort().map(label=>{const calls=sourceCalls.filter(c=>labels(c).includes(label));return {label,volume:calls.length,answered:calls.filter(c=>c.answered).length,missed:calls.filter(c=>c.missed).length,handoffs:calls.filter(c=>c.receptionistWork.steps.some(s=>['crm','support'].includes(s.kind)&&s.confirmed)).length,pendingWork:calls.filter(c=>workStates(c.receptionistWork).pending).length,contained:calls.filter(c=>c.contained).length,converted:calls.filter(c=>c.conversionEligible&&c.converted).length,serviceSeconds:calls.flatMap(c=>c.handlingOffers).filter(offer=>key!=='handlingUser'||offer.agent_id===label).reduce((seconds,offer)=>seconds+offer.service_seconds,0),sourceCallIds:calls.map(c=>c.id)}})
 }
 const receptionistCalls=sourceCalls.filter(c=>c.receptionistEligible),containedCalls=receptionistCalls.filter(c=>c.contained),conversionCalls=sourceCalls.filter(c=>c.conversionEligible),convertedCalls=conversionCalls.filter(c=>c.converted)
 const ratio=(numerator:number,denominator:number)=>({numerator,denominator,value:denominator?numerator/denominator:null})
 return {capturedAt,filters,timezone:config.timezone,interval:{startAt:config.startAt,endAt:config.endAt},basis:'Canonical native calls once each; provider completed or in-progress means answered, not independently qualified staff audio. Missed means no answered leg and terminal no-answer, busy, failed or canceled. Unknown and other states remain in volume only. Person means current case owner. Team and location mean current owner-maintained business-number assignments, independent of staff teams; absent assignments use Unassigned. Source calls retain the assignment revision, with zero meaning no assignment. Hour includes UTC offset so repeated DST hours stay distinct. All native totals, FCR candidates, recovery cases and surveys use the selected source calls; FCR surrounding contacts retain the full contextual window. Reviewed queue entries retain their supplied observations. Exact canonical call IDs connect those entries to native calls; unlinked imported identities do not manufacture carrier calls.',
  fcr,totals:{volume:sourceCalls.length,answered:sourceCalls.filter(c=>c.answered).length,missed:sourceCalls.filter(c=>c.missed).length,unknown:sourceCalls.filter(c=>!c.answered&&!c.missed).length,legs:new Set(rows.filter(r=>r.kind==='call_leg'&&callIds.has(r.call_id)).map(r=>r.id)).size},byHour:group('hour'),byPerson:group('person'),byHandlingUser:group('handlingUser'),byTrackingSource:group('trackingSource'),byNumber:group('number'),byTeam:group('team'),byLocation:group('location'),sourceCalls,
  attribution:{calls:sourceCalls.filter(c=>c.handlingUsers.length).length,unattributed:sourceCalls.filter(c=>!c.handlingUsers.length).length,basis:'Handling users require completed provider-read-back queue offers bound to the canonical source and parent call. Case ownership and ringing reservations are excluded. A transferred call appears once for each verified handler; group volumes are not additive. Provider completion does not certify independent staff audio.'},
  receptionist:receptionistSummary(sourceCalls),
  containment:{...ratio(containedCalls.length,receptionistCalls.length),eligibleCallIds:receptionistCalls.map(c=>c.id),containedCallIds:containedCalls.map(c=>c.id),excludedOpen:sourceCalls.filter(c=>c.receptionistOutcomeIds.length&&!c.terminal).length,unlinkedOutcomes:outcomeSources.outcomes.filter(o=>o.created_at>=config.startAt&&o.created_at<config.endAt&&!allSourceCalls.some(c=>c.id===o.call_id&&c.caseId===o.case_id)).length,basis:containmentBasis},
  conversion:{...ratio(convertedCalls.length,conversionCalls.length),windowHours:config.repeatWindowHours,eligibleCallIds:conversionCalls.map(c=>c.id),convertedCallIds:convertedCalls.map(c=>c.id),excluded:{unattributed:sourceCalls.filter(c=>c.trackingSource==='Unattributed').length,immature:sourceCalls.filter(c=>c.inbound&&!c.mature).length,unknownIdentity:sourceCalls.filter(c=>c.inbound&&!c.knownIdentity).length},basis:conversionBasis},
  recovery:{cases:new Set(recoveries.map(r=>r.case_id)).size,confirmed:new Set(recoveries.filter(r=>r.state==='resolved'&&r.confirmed_step_id).map(r=>r.case_id)).size,caseIds:[...new Set(recoveries.map(r=>r.case_id))],confirmedCaseIds:[...new Set(recoveries.filter(r=>r.state==='resolved'&&r.confirmed_step_id).map(r=>r.case_id))]},
  csat:{invitations:surveys.length,eligibleDelivered:delivered,responses:ratings.length,responseRate:delivered?ratings.length/delivered:null,mean:ratings.length?ratings.reduce((sum,i)=>sum+i.rating!,0)/ratings.length:null,basis:'Customer ratings only; AI sentiment and silence are excluded. Response rate denominator is independently delivered eligible invitations.'}}
}
const cell=(v:unknown)=>{let s=String(v??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'}
export function analyticsCsv(report:Awaited<ReturnType<typeof nativeAnalytics>>) {
 return [['call_id','case_id','occurred_at_utc','local_hour_with_offset','timezone','person','number','team','location','tracking_source','handling_users','handling_offer_ids','receptionist_outcome_ids','confirmed_receptionist_effect_ids','pending_receptionist_effect_ids','open_receptionist_exception_ids','native_booking_contained','booking_converted','conversion_eligible','provider_status','answered','missed','captured_at_utc'],...report.sourceCalls.map(c=>[c.id,c.caseId,new Date(c.occurredAt).toISOString(),c.hour,report.timezone,c.person,c.number,c.team,c.location,c.trackingSource,c.handlingUsers.join(' '),c.handlingOffers.map(o=>o.offer_id).join(' '),c.receptionistOutcomeIds.join(' '),c.receptionistWork.steps.filter(s=>s.confirmed).map(s=>s.id).join(' '),c.receptionistWork.steps.filter(s=>!s.confirmed&&s.state!=='rejected').map(s=>s.id).join(' '),c.receptionistWork.exceptions.filter(x=>x.state==='open'||x.state==='held').map(x=>x.id).join(' '),c.contained,c.converted&&c.conversionEligible,c.conversionEligible,c.status,c.answered,c.missed,new Date(report.capturedAt).toISOString()])].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n'
}
