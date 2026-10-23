import type { Bindings } from '../../auth.server'
import { runtimeBindings, operatorAuth } from '../../auth.server'
import { id } from '../core'
import { commit } from './store'

/** Receipt of a native HTTP request, never a claim of a remote effect. No body,
 * query, URL parameter, response content, recipient or credentials are retained. */
export async function observeProduct(request:Request,original:Bindings,handle:()=>Promise<Response>){
 const path=new URL(request.url).pathname
 const match=path.match(/^\/(?:api\/handset|app)\/(cases|records|filters|grants|audit|sources|admin|queues|reports|metrics|protection|dialer|front-desk|recordings|receptionist|followups|recovery|rules)(?:\/|$)/)
 const imports=/^\/(?:app\/import|api\/operator\/import)(?:\/|$)/.test(path)
 if(!match&&!imports)return handle()
 const names:Record<string,string>={cases:'records',records:'records',filters:'records',grants:'authority',audit:'audit',sources:'source',admin:'admin',queues:'queue',reports:'metrics',metrics:'metrics',protection:'protection',dialer:'dialer','front-desk':'frontdesk',recordings:'recording',receptionist:'receptionist',followups:'followup',recovery:'recovery',rules:'automation'}
 const env=runtimeBindings(original),actor=await operatorAuth(env).getSession(request)
 if(!actor)return handle()
 const subject=id(),action=(imports?'import':names[match![1]])+'.request'
 await commit(env,actor,action,subject,'uncertain',[],false)
 try{
  const response=await handle()
  await commit(env,actor,action,subject,response.status>=500?'failed':response.status>=400?'refused':response.status===202?'uncertain':'completed',[],false)
  return response
 }catch(error){await commit(env,actor,action,subject,'failed',[],false);throw error}
}
