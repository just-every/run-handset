import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Bindings } from '../../auth.server'
import type { InvocationIdentity, CallResult } from '../../modules/agent-door/index.ts'
import { handsetAgentDoor } from './door'

interface Invocation {id:string;name:string;arguments:string;identity:string;state:string;result:string|null}
/** Native service boundary: only explicitly bound trusted Workers can enqueue.
 * There is no HTTP job injection route. Authority is checked again when drained. */
export class HandsetAgentJobs extends WorkerEntrypoint<Bindings> {
 async enqueue(name:string,args:Record<string,unknown>,who:InvocationIdentity):Promise<string> {
  const id=crypto.randomUUID()
  await this.env.DB.prepare('INSERT INTO hnd_agent_invocations(id,name,arguments,identity,state,created_at) VALUES (?,?,?,?,?,?)')
   .bind(id,name,JSON.stringify(args),JSON.stringify(who),'queued',Date.now()).run()
  return id
 }
 async drain(id:string):Promise<CallResult> {
  const job=await this.env.DB.prepare('SELECT * FROM hnd_agent_invocations WHERE id=?').bind(id).first<Invocation>()
  if(!job)throw new Error('Invocation unavailable')
  if(job.state==='done')return handsetAgentDoor(this.env).invoke(job.name,JSON.parse(job.arguments),JSON.parse(job.identity))
  const claimed=await this.env.DB.prepare("UPDATE hnd_agent_invocations SET state='running' WHERE id=? AND state='queued'").bind(id).run()
  if(!claimed.meta.changes)throw new Error('Invocation already running; reconcile before retry')
  // Failed/uncertain executions stay running. Do not blindly resend them.
  const result=await handsetAgentDoor(this.env).invoke(job.name,JSON.parse(job.arguments),JSON.parse(job.identity))
  await this.env.DB.prepare("UPDATE hnd_agent_invocations SET state='done',result=? WHERE id=? AND state='running'").bind(JSON.stringify(result),id).run()
  return result
 }
}
