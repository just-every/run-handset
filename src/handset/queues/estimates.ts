import { statement, type Context } from './storage'
import { matches, presenceFreshMs, type Agent, type Entry, type Queue } from './model'

export async function waitEstimate(ctx:Context,row:Entry,q:Queue,position:number){
 const measured=await statement(ctx,'SELECT count(*) AS samples,avg(service_seconds) AS mean FROM hnd_queue_service_observations WHERE queue_id=? AND language=? AND skills=?',q.id,row.language,row.skills).first<{samples:number;mean:number|null}>()
 if(!measured?.samples||!measured.mean)return {seconds:null,samples:0,basis:'insufficient_verified_media_samples'}
 const staff=(await statement(ctx,`SELECT a.* FROM hnd_queue_agents a JOIN hnd_queue_memberships m ON m.operator_id=a.operator_id JOIN oa_operators o ON o.id=a.operator_id WHERE m.queue_id=? AND m.logged_in=1 AND o.status='active' AND a.availability IN ('available','busy') AND a.heartbeat_at>?`,q.id,Date.now()-presenceFreshMs).all<Agent>()).results.filter(a=>matches(a,row,q))
 const slots=staff.reduce((sum,a)=>sum+a.capacity,0)
 if(!slots)return {seconds:null,samples:measured.samples,basis:'no_fresh_qualified_staff'}
 return {seconds:Math.ceil((measured.mean+q.wrap_seconds)*Math.ceil(position/slots)),samples:measured.samples,basis:'provider_readback_completed_service_mean_with_wrap_and_staffed_capacity'}
}
