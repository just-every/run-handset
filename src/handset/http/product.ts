import { voicemailDoor } from '../voicemail/doors'
import { directoryDoor } from '../directory/doors'
import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { session, owner, json, input, Fault, page } from '../core'
import { numberRefusal } from '../numbers/console'
import { numbersDoor } from '../numbers/doors'
import { exportDoor } from '../exports/doors'
import { consentDoor } from '../consent/doors'
import { surveyDoor } from '../surveys/doors'
import { knowledgeDoor } from '../knowledge/doors'
import { erasureDoor } from '../erasure/doors'
import { qualityDoor } from '../quality/doors'
import { flowConsole } from '../flows/console'
import { flowDoor } from '../flows/doors'
import { promptConsole } from '../prompts/console'
import { promptDoor } from '../prompts/doors'
import { roleDoor } from '../access/role-doors'
import { transcriptPage } from '../transcripts/pages'
import { transcriptDoor } from '../transcripts/doors'
import { delegationDoor } from '../delegation/doors'
import { recordingsPage } from '../recording/doors'
import { scopeDoor } from '../authority/sponsors'
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
import { callbackDoor } from '../callbacks/doors'
import { followupDoor } from '../followups/doors'
import { ownerDoor as receptionistDoor } from '../receptionist/doors'
import { markCurrent } from '../shell'

export async function productResponse(request: Request, original: Bindings): Promise<Response|null> {
 const response = await route(request, original)
 return response && markCurrent(new URL(request.url).pathname, response)
}

async function route(request: Request, original: Bindings): Promise<Response|null> {
 const url = new URL(request.url), path = url.pathname, html = path.startsWith('/app/')
 if (!/^\/(api\/handset|app\/(numbers|exports|consent|surveys|cases|records|audit|grants|sources|admin|queues|reports\/queues|protection|dialer|front-desk|recordings|transcripts|flows|prompts|receptionist|rules|followups|recovery|callbacks|operations))(\/|$)/.test(path)) return null
 let auth: {env:Bindings;session:Session}|undefined
 try {
  auth = await session(request,original)
  const {env,session:actor} = auth, db=env.DB
  if(path==='/app/numbers'||path.startsWith('/app/numbers/')||path==='/api/handset/numbers'||path.startsWith('/api/handset/numbers/'))return await numbersDoor(request,env,actor,request.method==='GET'?undefined:await input(request))
  if(path==='/api/handset/voicemail'||path.startsWith('/api/handset/voicemail/'))return await voicemailDoor(request,env,actor,request.method==='GET'?undefined:await input(request))
  if(path==='/api/handset/directory'||path.startsWith('/api/handset/directory/'))return await directoryDoor(request,env,actor,request.method==='GET'?undefined:await input(request))
  for(const [root,door] of [['consent',consentDoor],['surveys',surveyDoor],['exports',exportDoor]] as const) {
   if(path==='/api/handset/'+root||path.startsWith('/api/handset/'+root+'/')||path==='/app/'+root||path.startsWith('/app/'+root+'/'))return await door(request,env,actor,request.method==='GET'?undefined:await input(request))
  }
  if(path==='/api/handset/knowledge'||path.startsWith('/api/handset/knowledge/'))return await knowledgeDoor(request,env,actor,request.method==='GET'?undefined:await input(request,200000))
  if(path==='/app/admin/erasure'||path.startsWith('/app/admin/erasure/')||path==='/api/handset/erasure'||path.startsWith('/api/handset/erasure/'))return await erasureDoor(request,env,actor,request.method==='GET'?undefined:await input(request))
  if(path==='/api/handset/quality'||path.startsWith('/api/handset/quality/')){
   return await qualityDoor(request,env,actor,request.method==='GET'?undefined:await input(request))
  }
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
  if(path==='/app/transcripts'||path.startsWith('/app/transcripts/'))return await transcriptPage(request,env,actor,request.method==='GET'?undefined:await input(request))
  if(path==='/api/handset/transcripts'||path.startsWith('/api/handset/transcripts/')){
   return await transcriptDoor(request,env,actor,request.method==='GET'?undefined:await input(request,1048576))
  }
  if(path==='/app/flows'||path.startsWith('/app/flows/'))return await flowConsole(request,env,actor,request.method==='GET'?undefined:await input(request))
  if(path==='/api/handset/flows'||path.startsWith('/api/handset/flows/'))return await flowDoor(request,env,actor,request.method==='GET'?undefined:await input(request))
  if(['/app/prompts/access','/api/handset/prompts/access'].some(root=>path===root||path.startsWith(root+'/')))return await roleDoor(request,env,actor,request.method==='GET'?undefined:await input(request))
  if(path==='/app/prompts'||path.startsWith('/app/prompts/'))return await promptConsole(request,env,actor,request.method==='GET'?undefined:await input(request,4500000))
  if(path==='/api/handset/prompts'||path.startsWith('/api/handset/prompts/'))return await promptDoor(request,env,actor,request.method==='GET'?undefined:await input(request,4500000))
  const records=await recordsDoor(request,env,actor)
  if(records)return records
  if(path==='/api/handset/grant-scopes'||path.startsWith('/api/handset/grant-scopes/'))return await scopeDoor(request,env,actor,request.method==='GET'?undefined:await input(request))
  // Delegated human authority uses native sessions at these existing API doors.
  // Administrative listings and credential management remain owner-only.
  if(actor.operator.role!=='owner'&&request.method==='POST'&&['/api/handset/grants','/api/handset/mcp/consent','/api/handset/grants/approve','/api/handset/grants/policy'].includes(path))return await authorityDoor(request,env,actor,await input(request))
  try { owner(actor) } catch(error) { await denied(env,actor,'product.access'); throw error }
  const read = request.method === 'GET', write = request.method === 'POST'
  for(const [root,door] of [
   ['queues',queueDoor],['metrics',metricsDoor],['protection',protectionDoor],['dialer',dialerDoor],['receptionist',receptionistDoor],['followups',followupDoor],['recovery',recoveryDoor],['callbacks',callbackDoor],['rules',rulesDoor],['delivery',deliveryDoor],['operations',operationsDoor],['compliance',complianceDoor],
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
   if(html&&path.startsWith('/app/numbers')){const refusal=numberRefusal(error.code);return page(refusal.title,refusal.body,error.status)}
   return html?page(error.code,`<p role="alert">${error.code.replaceAll('_',' ')}</p><a href="/app/cases">Return to cases</a>`,error.status):json({error:error.code,...(error.detail?{detail:error.detail}:{})},error.status)
  }
  console.error('Handset product request failed',error instanceof Error?error.name:'unknown')
  return html?page('Temporarily unavailable','<p role="alert">No completion is claimed. Retry or reload the current record.</p>',503):json({error:'store_unavailable'},503)
 }
}
