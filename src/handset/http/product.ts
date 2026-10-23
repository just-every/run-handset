import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { session, owner, json, input, Fault, page } from '../core'
import { delegationDoor } from '../delegation/doors'
import { recordingsPage } from '../recording/doors'
import { authorityDoor } from '../authority/doors'
import { auditDoor } from '../audit/doors'
import { denied } from '../audit/store'
import { sourceDoor } from '../providers/twilio'
import { adminDoor } from '../admin/doors'
import { queueDoor } from '../queues/doors'
import { metricsDoor } from '../metrics/doors'
import { protectionDoor } from '../protection/doors'
import { dialerDoor } from '../dialer/doors'
import { recordsDoor } from '../records/doors'
import { complianceDoor } from '../compliance/doors'
import { workConsole } from '../automation/console'
import { operationsDoor } from '../operations/doors'
import { deliveryDoor } from '../integrations/delivery/doors'
import { rulesDoor } from '../automation/doors'
import { recoveryDoor } from '../recovery/doors'
import { followupDoor } from '../followups/doors'
import { ownerDoor as receptionistDoor } from '../receptionist/doors'

export async function productResponse(request: Request, original: Bindings): Promise<Response|null> {
 const url = new URL(request.url), path = url.pathname, html = path.startsWith('/app/')
 if (!/^\/(api\/handset|app\/(cases|records|audit|grants|sources|admin|queues|reports\/queues|protection|dialer|front-desk|recordings|receptionist|rules|followups|recovery|operations))(\/|$)/.test(path)) return null
 let auth: {env:Bindings;session:Session}|undefined
 try {
  auth = await session(request,original)
  const {env,session:actor} = auth, db=env.DB
  if(path==='/api/handset/admin'||path.startsWith('/api/handset/admin/')||path.startsWith('/app/admin/')){
   const response=await adminDoor(request,env,actor,request.method==='GET'?undefined:await input(request,2097152))
   if(response)return response
   throw new Fault('not_found',404)
  }
  if(path==='/api/handset/queues'||path.startsWith('/api/handset/queues/')||path==='/app/queues'||path.startsWith('/app/queues/')){
   const response=await queueDoor(request,env,actor,request.method==='GET'?undefined:await input(request))
   if(response)return response
   throw new Fault('not_found',404)
  }
  if(path==='/api/handset/dialer'||path.startsWith('/api/handset/dialer/')||path==='/app/dialer'||path.startsWith('/app/dialer/')){
   const response=await dialerDoor(request,env,actor,request.method==='GET'?undefined:await input(request,2097152))
   if(response)return response
   throw new Fault('not_found',404)
  }
  if(path==='/app/front-desk'||path.startsWith('/app/front-desk/')||path==='/api/handset/front-desk'||path.startsWith('/api/handset/front-desk/')){
   return await delegationDoor(request,env,actor,request.method==='GET'?undefined:await input(request))
  }
  if(path==='/app/recordings'||path.startsWith('/app/recordings/')||path.startsWith('/api/handset/recordings/')){
   return await recordingsPage(request,env,actor,request.method==='GET'?undefined:await input(request))
  }
  if (path.startsWith('/api/handset/audit') || path.startsWith('/app/audit')) {
   const response = await auditDoor(request,env,actor,request.method==='GET' ? undefined : await input(request,2097152))
   if(response)return response
   throw new Fault('not_found',404)
  }
  if(path.startsWith('/api/handset/sources') || path.startsWith('/app/sources')){
   const response=await sourceDoor(request,env,actor,request.method==='GET'?undefined:await input(request))
   if(response)return response
   throw new Fault('not_found',404)
  }
  const records=await recordsDoor(request,env,actor)
  if(records)return records
  try { owner(actor) } catch(error) { await denied(env,actor,'product.access'); throw error }
  const read = request.method === 'GET', write = request.method === 'POST'
  for(const [root,door] of [
   ['queues',queueDoor],['metrics',metricsDoor],['protection',protectionDoor],['dialer',dialerDoor],['receptionist',receptionistDoor],['followups',followupDoor],['recovery',recoveryDoor],['rules',rulesDoor],['delivery',deliveryDoor],['operations',operationsDoor],['compliance',complianceDoor],
  ] as const){
   const appRoot=root==='metrics'?'/app/reports/queues':'/app/'+root
   if(path==='/api/handset/'+root||path.startsWith('/api/handset/'+root+'/')||path===appRoot||path.startsWith(appRoot+'/')){
    const value=read?undefined:await input(request,2097152)
    const console=await workConsole(request,env,actor,root,door,value)
    if(console)return console
    const response=await door(request,env,actor,value)
    if(response)return response
   }
  }
  if (path.startsWith('/api/handset/grants') || path.startsWith('/app/grants') || path === '/api/handset/mcp/consent') {
   if(!read && !write)throw new Fault('method_not_allowed',405)
   const response=await authorityDoor(request,env,actor,read?undefined:await input(request))
   if(response)return response
  }
  throw new Fault('not_found',404)
 } catch(error) {
  if(error instanceof Fault){
   if(auth && error.status<500 && error.code!=='owner_required')await denied(auth.env,auth.session,'product.request')
   return html?page(error.code,`<p role="alert">${error.code.replaceAll('_',' ')}</p><a href="/app/cases">Return to cases</a>`,error.status):json({error:error.code,...(error.detail?{detail:error.detail}:{})},error.status)
  }
  console.error('Handset product request failed',error instanceof Error?error.name:'unknown')
  return html?page('Temporarily unavailable','<p role="alert">No completion is claimed. Retry or reload the current record.</p>',503):json({error:'store_unavailable'},503)
 }
}
