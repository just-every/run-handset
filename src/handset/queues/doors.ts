import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit, denied } from '../audit/store'
import { Fault, input, integer, json, keys, owner, session, text, type ObjectValue } from '../core'
import { configureAgent, configureQueue, membership, presence } from './configuration'
import { enqueue, entryAction } from './entries'
import { events, snapshot } from './read'
import { dispatch, reconcile } from './routing'
import { queueSettingsPage, queuesPage } from './pages'
import { queue } from './storage'
import { bindSource, revokeBinding } from './provider-consent'
import { revokeMediaRoute, writeAgentRoute, writeOverflowRoute } from './media-policy'
import { selfService } from './self-service'
import { offerById } from './offers'
import { recoverOffer } from './offer-readback'
import { queueMediaPage } from './media-pages'

function formValues(value:ObjectValue){
 const data={...value}
 for(const name of ['priority','capacity','maxWaitSeconds','wrapSeconds','maxWaiting','revision','loggedIn'])if(typeof data[name]==='string')data[name]=Number(data[name])
 for(const name of ['skills','languages'])if(typeof data[name]==='string')data[name]=String(data[name]).split(',').map(v=>v.trim()).filter(Boolean)
 if(data.overflowQueueId==='')delete data.overflowQueueId
 return data
}
const redirect=(location:string)=>new Response(null,{status:303,headers:{location,'cache-control':'no-store'}})
// Queue setup's own forms return to Queue setup; media approvals to Media routes; daily work to Queues.
const returnTo=(path:string)=>/\/(agents|overflow)\/[^/]+\/route(?:\/revoke)?$|\/offers\/[^/]+\/reconcile$/.test(path)?'/app/queues/media':/^\/app\/queues(?:\/create|\/[^/]+\/configure|\/agents|\/sources(?:\/revoke)?)?$/.test(path)?'/app/queues/settings':'/app/queues'
export async function queueDoor(request:Request,env:Bindings,actor:Session,data?:ObjectValue):Promise<Response|null>{
 const url=new URL(request.url),path=url.pathname,html=path.startsWith('/app/'),base=html?'/app/queues':'/api/handset/queues'
 if(path!==base&&!path.startsWith(base+'/'))return null
 // Repeat session and origin checks at this public module boundary as well as
 // in the product router; direct handler callers cannot bypass native auth.
 const checked=await session(request,env)
 if(checked.session.id!==actor.id)throw new Fault('session_mismatch',403)
 if(html&&path===base&&request.method==='GET'&&checked.session.operator.role!=='owner')return new Response(null,{status:303,headers:{location:base+'/self','cache-control':'no-store'}})
 if(path===base+'/self'||checked.session.operator.role!=='owner')return selfService(request,checked.env,checked.session,base,data)
 try{owner(checked.session)}catch(error){await denied(env,actor,'product.access');throw error}
 const ctx={env,actor:checked.session},read=request.method==='GET'
 if(!read&&request.method!=='POST')throw new Fault('method_not_allowed',405)
 if(read){
  if(path===base){
   keys(Object.fromEntries(url.searchParams),[])
   const result=await snapshot(ctx);await commit(env,actor,'product.access','installation','completed')
   if(!html)return json(result)
   const people=(await env.DB.prepare("SELECT id,display_name FROM oa_operators WHERE status='active' ORDER BY display_name,id").all<{id:string;display_name:string}>()).results
   return queuesPage(result,people)
  }
  if(html&&path===base+'/settings'){
   const result=await snapshot(ctx);await commit(env,actor,'product.access','installation','completed')
   return queueSettingsPage(result,(await env.DB.prepare("SELECT id,display_name FROM oa_operators WHERE status='active' ORDER BY display_name,id").all<{id:string;display_name:string}>()).results)
  }
  if(html&&path===base+'/media'){const result=await snapshot(ctx);await commit(env,actor,'product.access','installation','completed');return queueMediaPage(result)}
  if(path===base+'/events'){
   keys(Object.fromEntries(url.searchParams),['after','queueId'])
   const queueId=url.searchParams.get('queueId')??undefined;if(queueId)await queue(ctx,queueId)
   const result=await events(ctx,integer(Number(url.searchParams.get('after')??0),'after'),queueId)
   await commit(env,actor,'product.access','installation','completed');return json(result)
  }
  const detail=path.match(new RegExp('^'+base+'/([^/]+)$'))
  if(detail){await queue(ctx,detail[1]);const result=await snapshot(ctx,detail[1]);await commit(env,actor,'product.access',detail[1],'completed');return json(result)}
  return null
 }
 let value=data??await input(request);if(html)value=formValues(value)
 let result:unknown,status=200
 if(path===base||path===base+'/create'){result=await configureQueue(ctx,value);status=201}
 else if(path===base+'/sources'){result=await bindSource(ctx,value);status=201}
 else if(path===base+'/sources/revoke'){keys(value,['bindingId']);result=await revokeBinding(ctx,text(value.bindingId,'bindingId'))}
 else if(path===base+'/agents'){result=await configureAgent(ctx,value);status=201}
 else if(path===base+'/presence')result=await presence(ctx,value)
 else if(path===base+'/reconcile'){keys(value,[]);result=await reconcile(ctx)}
 else if(path===base+'/admit'){
  const queueId=text(value.queueId,'queueId');delete value.queueId;result=await enqueue(ctx,queueId,value);status=201
 }else{
  const route=path.match(new RegExp('^'+base+'/(agents|overflow)/([^/]+)/route(/revoke)?$'))
  const offer=path.match(new RegExp('^'+base+'/offers/([^/]+)/reconcile$'))
  const q=path.match(new RegExp('^'+base+'/([^/]+)/(configure|memberships|entries|dispatch)$'))
  const action=path.match(new RegExp('^'+base+'/entries/([^/]+)/(accept|complete|abandon)$'))
  if(route){
   if(route[3]){keys(value,[]);result=await revokeMediaRoute(ctx,route[1]==='agents'?'agent':'overflow',route[2])}
   else result=route[1]==='agents'?await writeAgentRoute(ctx,route[2],value):await writeOverflowRoute(ctx,route[2],value)
  }else if(offer){keys(value,[]);result=await recoverOffer(ctx,await offerById(ctx,offer[1]))}
  else if(q){
   if(q[2]==='configure')result=await configureQueue(ctx,value,q[1])
   else if(q[2]==='memberships')result=await membership(ctx,q[1],value)
   else if(q[2]==='entries'){result=await enqueue(ctx,q[1],value);status=201}
   else{keys(value,[]);result=await dispatch(ctx,q[1])}
  }else if(action)result=await entryAction(ctx,action[1],action[2],value)
  else return null
 }
 return html?redirect(returnTo(path)):json(result,status)
}
