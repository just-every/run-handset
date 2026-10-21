import type { Bindings } from '../../auth.server'
import { Fault } from '../core'
import { statement, type Context } from './storage'
import { dispatch } from './routing'

/** Native-only scheduled reconciliation. Never dials, plays audio or sends data. */
export async function tickQueues(env:Bindings){
 const runtime=await env.DB.prepare('SELECT audit_actor FROM hnd_queue_runtime WHERE singleton=1').first<{audit_actor:string}>()
 if(!runtime)return {queues:[],transport:'unknown'}
 const ctx:Context={env,auditActor:runtime.audit_actor},queues=(await statement(ctx,'SELECT id FROM hnd_queues ORDER BY created_at,id').all<{id:string}>()).results
 const results=[]
 for(const q of queues){
  try{results.push({queueId:q.id,...await dispatch(ctx,q.id)})}
  catch(error){if(error instanceof Fault&&error.status===409)results.push({queueId:q.id,conflict:error.code});else throw error}
 }
 return {queues:results,transport:'unknown'}
}
