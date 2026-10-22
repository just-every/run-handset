import { runtimeBindings, type Bindings } from '../../auth.server'
import { Fault } from '../core'
import { capacity } from './capacity'
import { listEligibility } from './eligibility'
import { pause } from './launch'
import { reconcileAttempt } from './readback'
import { list, sql } from './storage'
import type { Attempt, Run } from './model'
// Scheduled work can observe and halt already-authorized work. It cannot create
// lists, expand approvals, retry uncertain Calls creation or launch new calls.
export async function tickDialer(original:Bindings){
 const env=runtimeBindings(original)
 const sessions=(await env.DB.prepare("SELECT * FROM hnd_dialer_sessions WHERE state='running' LIMIT 100").all<Run>()).results
 for(const r of sessions){const l=await list({env},r.list_id),ctx={env,auditActor:l.source_id};try{const e=await listEligibility(ctx,l,r.mode);await capacity(ctx,l,{...e.policy,inboundReserve:Math.max(0,e.policy.inboundReserve-1)})}catch(error){if(error instanceof Fault)await pause(ctx,r,error.code);else throw error}}
 const attempts=(await sql({env},"SELECT * FROM hnd_dialer_attempts WHERE state IN ('uncertain','ringing','active') ORDER BY created_at LIMIT 100").all<Attempt>()).results
 let observed=0,unresolved=0
 for(const a of attempts){const l=await list({env},a.list_id);try{const result=await reconcileAttempt({env,auditActor:l.source_id},a);if(result.held)unresolved++;else observed++}catch(error){if(error instanceof Fault){unresolved++;continue}throw error}}
 return {observed,unresolved,launched:0}
}
