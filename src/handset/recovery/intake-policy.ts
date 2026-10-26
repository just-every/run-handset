import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { Fault, integer, keys, text, type ObjectValue } from '../core'
import { guard, sql } from '../delegation/store'
import { validateHours, type FlowHours } from '../flows/evaluation'
import { activeSourceById, sourceFence } from '../providers/sources'

export interface IntakePolicy { source_id:string; revision:number; source_revision:number; timezone:string; hours:string; approved_by:string; owner_version:number; created_at:number; revoked_at:number|null }
const current = `p.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=p.owner_version AND NOT EXISTS(SELECT 1 FROM hnd_recovery_intake_policies newer WHERE newer.source_id=p.source_id AND newer.revision>p.revision)`
const latest = (env:Bindings, sourceId:string) => sql(env,'SELECT * FROM hnd_recovery_intake_policies WHERE source_id=? ORDER BY revision DESC LIMIT 1',sourceId).first<IntakePolicy>()
export const intakePolicy = (env:Bindings, sourceId:string) => sql(env,`SELECT p.* FROM hnd_recovery_intake_policies p JOIN oa_operators o ON o.id=p.approved_by WHERE p.source_id=? AND ${current}`,sourceId).first<IntakePolicy>()
export const intakeFence = (env:Bindings, p:IntakePolicy) => guard(env,`SELECT count(*) FROM hnd_recovery_intake_policies p JOIN oa_operators o ON o.id=p.approved_by WHERE p.source_id=? AND p.revision=? AND ${current}`,p.source_id,p.revision)
export const intakeAuthority = (p:IntakePolicy) => ({approval:{id:p.source_id,revision:p.revision,ownerVersion:p.owner_version}})

export async function configureIntake(env:Bindings, actor:Session, value:ObjectValue) {
 keys(value,['sourceId','revision','timezone','hours','confirm'])
 if(value.confirm!=='approve owned missed-call intake')throw new Fault('explicit_intake_approval_required',403)
 const source=await activeSourceById(env,text(value.sourceId,'sourceId',64))
 if(!source)throw new Fault('active_source_required',409)
 const prior=await latest(env,source.id),revision=integer(value.revision,'revision',0)
 if(revision!==(prior?.revision??0))throw new Fault('intake_revision_conflict',409)
 const timezone=text(value.timezone,'timezone',100),hours=validateHours(value.hours)
 if(!hours.weekly.length)throw new Fault('intake_open_hours_required')
 try{new Intl.DateTimeFormat('en-US',{timeZone:timezone})}catch{throw new Fault('invalid_timezone')}
 const next: IntakePolicy={source_id:source.id,revision:revision+1,source_revision:source.revision,timezone,hours:JSON.stringify(hours),approved_by:actor.operator.id,owner_version:actor.operator.version,created_at:Date.now(),revoked_at:null}
 await commit(env,actor,'recovery.policy',source.id,'completed',[sourceFence(env,source),
  guard(env,'SELECT CASE WHEN COALESCE((SELECT max(revision) FROM hnd_recovery_intake_policies WHERE source_id=?),0)=? THEN 1 ELSE 0 END',source.id,revision),
  sql(env,'INSERT INTO hnd_recovery_intake_policies VALUES (?,?,?,?,?,?,?,?,?)',...Object.values(next)),
 ],true,{...sourcePolicy(source),...intakeAuthority(next)})
 return {policy:next,customerContact:'not authorized'}
}
export async function revokeIntake(env:Bindings, actor:Session, value:ObjectValue) {
 keys(value,['sourceId','revision'])
 const prior=await latest(env,text(value.sourceId,'sourceId',64)),revision=integer(value.revision,'revision',1)
 if(!prior)throw new Fault('intake_policy_not_found',404)
 if(prior.revision!==revision)throw new Fault('intake_revision_conflict',409)
 const now=Date.now(),next={...prior,revision:revision+1,created_at:now,revoked_at:now}
 await commit(env,actor,'recovery.policy',prior.source_id,'completed',[
  guard(env,'SELECT CASE WHEN (SELECT max(revision) FROM hnd_recovery_intake_policies WHERE source_id=?)=? THEN 1 ELSE 0 END',prior.source_id,revision),
  sql(env,'INSERT INTO hnd_recovery_intake_policies VALUES (?,?,?,?,?,?,?,?,?)',next.source_id,next.revision,next.source_revision,next.timezone,next.hours,next.approved_by,next.owner_version,next.created_at,next.revoked_at),
 ],true,intakeAuthority(prior))
 return {revoked:true,revision:next.revision}
}
export function withinIntakeHours(policy:IntakePolicy, at:number) {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:policy.timezone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at))
 const part=(name:string)=>parts.find(p=>p.type===name)!.value
 const day=(new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`).getUTCDay()+6)%7+1,minute=Number(part('hour'))*60+Number(part('minute'))
 return (JSON.parse(policy.hours) as FlowHours).weekly.some(w=>w.days.includes(day)&&minute>=w.startMinute&&minute<w.endMinute)
}
export async function intakeSnapshot(env:Bindings) {
 const rows=(await sql(env,`SELECT p.*,o.display_name AS owner_name,CASE WHEN o.status='active' AND o.role='owner' AND o.version=p.owner_version AND p.revoked_at IS NULL THEN 1 ELSE 0 END AS owner_current FROM hnd_recovery_intake_policies p JOIN oa_operators o ON o.id=p.approved_by WHERE NOT EXISTS(SELECT 1 FROM hnd_recovery_intake_policies newer WHERE newer.source_id=p.source_id AND newer.revision>p.revision) ORDER BY p.created_at DESC LIMIT 50`).all<IntakePolicy & {owner_name:string;owner_current:number}>()).results
 const candidates=(await sql(env,'SELECT id FROM hnd_sources WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 50').all<{id:string}>()).results
 const sources=(await Promise.all(candidates.map(s=>activeSourceById(env,s.id)))).filter(s=>s!==null)
 return {intakeSources:sources.map(s=>({id:s.id,e164:s.e164})),intakePolicies:rows.map(p=>({...p,current:!!p.owner_current&&sources.some(s=>s.id===p.source_id&&s.revision===p.source_revision)}))}
}
