import type { Bindings } from '../../auth.server'
import type { Config } from './model'
import { callRows } from '../exports/logs'
import { matchesNativeFilters, parseNativeFilters, type NativeFilters } from './filters'
import { listGroups } from './groups'

// Canonical customer calls are counted once, independently of endpoint offers.
export async function nativeAnalytics(env:Bindings,config:Config,rawFilters:NativeFilters={}) {
 const filters=parseNativeFilters(rawFilters),capturedAt=Date.now()
 const [rows,assignments]=await Promise.all([
  callRows(env,{from:config.startAt,to:config.endAt,timezone:config.timezone,queueId:config.queueId==='*'?null:config.queueId,ownerId:null},capturedAt),
  listGroups(env.DB),
 ])
 const groups=new Map(assignments.map(assignment=>[assignment.number,assignment]))
 const roots=new Map(rows.filter(r=>r.kind==='call_session').map(r=>[r.id,r]))
 const sourceCalls=[...roots.values()].map(r=>{
  const data=JSON.parse(r.data),status=r.status_data?JSON.parse(r.status_data):data
  const legs=rows.filter(leg=>leg.call_id===r.id)
  const statuses=legs.map(leg=>leg.provider_status??(leg.status_data?JSON.parse(leg.status_data):JSON.parse(leg.data)).providerStatus)
  const answered=statuses.some(s=>['completed','in-progress'].includes(s))
  const missed=!answered&&['no-answer','busy','failed','canceled'].includes(status.providerStatus)
  const hour=new Intl.DateTimeFormat('en-CA',{timeZone:config.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'}).format(r.occurred_at)
  const number=String(data.to??'Unknown'),assignment=groups.get(number)
  return {id:r.id,caseId:r.case_id,occurredAt:r.occurred_at,hour,person:r.owner_id??'Unassigned',number,team:assignment?.team??'Unassigned',location:assignment?.location??'Unassigned',groupRevision:assignment?.revision??0,status:String(status.providerStatus??'unknown'),answered,missed}
 }).filter(call=>matchesNativeFilters(call,filters)).sort((a,b)=>a.occurredAt-b.occurredAt||a.id.localeCompare(b.id))
 const caseIds=new Set(sourceCalls.map(c=>c.caseId)),callIds=new Set(sourceCalls.map(c=>c.id))
 const recoveries=(await env.DB.prepare(`SELECT r.id,r.case_id,r.state,r.resolution,CASE WHEN o.id IS NOT NULL THEN s.id END AS confirmed_step_id FROM hnd_recovery r
  LEFT JOIN hnd_rx_steps s ON s.id=json_extract(r.resolution,'$.stepId') AND s.kind='booking' AND s.state='confirmed'
  LEFT JOIN hnd_rx_outcomes o ON o.id=s.outcome_id AND o.case_id=r.case_id`).all<{id:string;case_id:string;state:string;resolution:string|null;confirmed_step_id:string|null}>()).results.filter(r=>caseIds.has(r.case_id))
 const surveys=(await env.DB.prepare(`SELECT i.call_record_id,i.eligible_at,r.rating FROM hnd_survey_invitations i LEFT JOIN hnd_survey_responses r ON r.invitation_id=i.id`).all<{call_record_id:string;eligible_at:number|null;rating:number|null}>()).results.filter(i=>callIds.has(i.call_record_id))
 const ratings=surveys.filter(i=>i.rating!==null),delivered=surveys.filter(i=>i.eligible_at!==null).length
 const windowMs=config.repeatWindowHours*3600000
 const contacts=(await env.DB.prepare(`SELECT r.id,r.case_id,r.occurred_at,r.data,p.source_id FROM hnd_records r JOIN hnd_record_sources p ON p.record_id=r.id AND p.source_kind='twilio'
  WHERE r.kind='call_session' AND r.occurred_at>=? AND r.occurred_at<? AND r.received_at<=? AND json_extract(r.data,'$.direction')='inbound'
  AND NOT EXISTS(SELECT 1 FROM hnd_records n WHERE n.supersedes_id=r.id)`).bind(Math.max(0,config.startAt-windowMs),config.endAt+windowMs,capturedAt).all<{id:string;case_id:string|null;occurred_at:number;data:string;source_id:string}>()).results.map(c=>{const d=JSON.parse(c.data);return {...c,identity:/^\+[1-9]\d{7,14}$/.test(d.from??'')&&/^\+[1-9]\d{7,14}$/.test(d.to??'')?JSON.stringify([c.source_id,d.from,d.to]):null}})
 const bookings=(await env.DB.prepare("SELECT o.case_id,s.updated_at FROM hnd_rx_steps s JOIN hnd_rx_outcomes o ON o.id=s.outcome_id WHERE s.kind='booking' AND s.state='confirmed' AND s.readback IS NOT NULL").all<{case_id:string;updated_at:number}>()).results
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
 const group=(key:'hour'|'person'|'number'|'team'|'location')=>[...new Set(sourceCalls.map(c=>c[key]))].sort().map(label=>{const calls=sourceCalls.filter(c=>c[key]===label);return {label,volume:calls.length,answered:calls.filter(c=>c.answered).length,missed:calls.filter(c=>c.missed).length,sourceCallIds:calls.map(c=>c.id)}})
 return {capturedAt,filters,timezone:config.timezone,interval:{startAt:config.startAt,endAt:config.endAt},basis:'Canonical native calls once each; provider completed or in-progress means answered, not independently qualified staff audio. Missed means no answered leg and terminal no-answer, busy, failed or canceled. Unknown and other states remain in volume only. Person means current case owner. Team and location mean current owner-maintained business-number assignments, independent of staff teams; absent assignments use Unassigned. Source calls retain the assignment revision, with zero meaning no assignment. Hour includes UTC offset so repeated DST hours stay distinct. All native totals, FCR candidates, recovery cases and surveys use the selected source calls; FCR surrounding contacts retain the full contextual window. Queue observations and native calls are separate source populations.',
  fcr,totals:{volume:sourceCalls.length,answered:sourceCalls.filter(c=>c.answered).length,missed:sourceCalls.filter(c=>c.missed).length,unknown:sourceCalls.filter(c=>!c.answered&&!c.missed).length,legs:new Set(rows.filter(r=>r.kind==='call_leg'&&callIds.has(r.call_id)).map(r=>r.id)).size},byHour:group('hour'),byPerson:group('person'),byNumber:group('number'),byTeam:group('team'),byLocation:group('location'),sourceCalls,
  recovery:{cases:new Set(recoveries.map(r=>r.case_id)).size,confirmed:new Set(recoveries.filter(r=>r.state==='resolved'&&r.confirmed_step_id).map(r=>r.case_id)).size,caseIds:[...new Set(recoveries.map(r=>r.case_id))],confirmedCaseIds:[...new Set(recoveries.filter(r=>r.state==='resolved'&&r.confirmed_step_id).map(r=>r.case_id))]},
  csat:{invitations:surveys.length,eligibleDelivered:delivered,responses:ratings.length,responseRate:delivered?ratings.length/delivered:null,mean:ratings.length?ratings.reduce((sum,i)=>sum+i.rating!,0)/ratings.length:null,basis:'Customer ratings only; AI sentiment and silence are excluded. Response rate denominator is independently delivered eligible invitations.'}}
}
const cell=(v:unknown)=>{let s=String(v??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'}
export function analyticsCsv(report:Awaited<ReturnType<typeof nativeAnalytics>>) {
 return [['call_id','case_id','occurred_at_utc','local_hour_with_offset','timezone','person','number','team','location','provider_status','answered','missed','captured_at_utc'],...report.sourceCalls.map(c=>[c.id,c.caseId,new Date(c.occurredAt).toISOString(),c.hour,report.timezone,c.person,c.number,c.team,c.location,c.status,c.answered,c.missed,new Date(report.capturedAt).toISOString()])].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n'
}
