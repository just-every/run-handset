import { choice, Fault, integer, keys, text, type ObjectValue } from '../core'

export const presenceFreshMs = 90000
export const reservationLeaseMs = 30000
export interface Queue {
 id:string; name:string; mode:'longest_idle'|'round_robin'; skills:string; max_wait_seconds:number; wrap_seconds:number; max_waiting:number;
 overflow_kind:'queue'|'voicemail'|'receptionist'; overflow_queue_id:string|null; revision:number; created_at:number; updated_at:number
}
export interface Agent {
 operator_id:string; skills:string; languages:string; capacity:number; availability:'available'|'busy'|'away'|'offline';
 heartbeat_at:number; idle_since:number; last_assignment_at:number; wrap_until:number; revision:number
}
export interface Entry {
 id:string; queue_id:string; origin_queue_id:string; call_id:string; language:string; skills:string; priority:number;
 state:'waiting'|'reserved'|'active'|'completed'|'abandoned'|'overflow'; agent_id:string|null; created_at:number; queued_at:number;
 deadline_at:number; reserved_at:number|null; accepted_at:number|null; ended_at:number|null; overflow_kind:string|null; reason:string; visited:string; revision:number
}
export interface Reservation { entry_id:string; agent_id:string; slot:number; lease_until:number; state:'reserved'|'active' }
export interface Membership {queue_id:string;operator_id:string;logged_in:number;priority:number;revision:number;updated_at:number}
export function list(value:unknown,name:string):string[] {
 if(!Array.isArray(value)||value.length>20)throw new Fault(`invalid_${name}`)
 return [...new Set(value.map(v=>text(v,name,60).toLowerCase()))].sort()
}
export const strings=(value:string)=>JSON.parse(value) as string[]
export function language(value:unknown){
 const result=text(value,'language',35).toLowerCase()
 if(!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(result))throw new Fault('invalid_language')
 return result
}
export function queueInput(value:ObjectValue){
 keys(value,['name','mode','skills','maxWaitSeconds','wrapSeconds','maxWaiting','overflowKind','overflowQueueId','revision','confirm'])
 if(value.confirm!=='approve native queue policy')throw new Fault('queue_consent_required',403)
 const overflowKind=choice(value.overflowKind,['queue','voicemail','receptionist'],'overflowKind')
 if(overflowKind!=='queue'&&value.overflowQueueId)throw new Fault('unexpected_overflow_queue')
 return {name:text(value.name,'name',120),mode:choice(value.mode??'longest_idle',['longest_idle','round_robin'],'mode'),
 skills:JSON.stringify(list(value.skills??[],'skills')),maxWait:integer(value.maxWaitSeconds,'maxWaitSeconds',1,86400),
 wrap:integer(value.wrapSeconds??30,'wrapSeconds',0,3600),maxWaiting:integer(value.maxWaiting??100,'maxWaiting',1,1000),
 overflowKind,overflowQueueId:overflowKind==='queue'?text(value.overflowQueueId,'overflowQueueId'):null}
}
export function matches(agent:Agent,entry:Entry,queue:Queue){
 const skills=strings(agent.skills),languages=strings(agent.languages)
 return languages.includes(entry.language)&&[...strings(queue.skills),...strings(entry.skills)].every(skill=>skills.includes(skill))
}
