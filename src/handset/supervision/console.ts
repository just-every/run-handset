import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, headers, input, keys, owner, session, type ObjectValue } from '../core'
import { issueGrant, revokeGrant } from './authority'
import { intervene, queueSnapshot, queueTimeline, supervisionOverview } from './store'
import { overviewPage, settingsPage, wallboardPage, liveBody } from './pages'
import { supervisionClient } from './client'

const base='/app/supervision'
const redirect=(location:string)=>new Response(null,{status:303,headers:{...headers,location}})
export async function supervisionConsole(request:Request,original:Bindings,actor:Session,data?:ObjectValue):Promise<Response|null>{
 const url=new URL(request.url),path=url.pathname
 if(path!=='/api/handset/supervision/poll.js'&&path!==base&&!path.startsWith(base+'/'))return null
 const checked=await session(request,original)
 if(checked.session.id!==actor.id)throw new Fault('session_mismatch',403)
 const {env,session:current}=checked
 keys(Object.fromEntries(url.searchParams),[])
 if(request.method==='GET'){
  if(path==='/api/handset/supervision/poll.js')return new Response(supervisionClient,{headers:{...headers,'content-type':'text/javascript; charset=utf-8'}})
  if(path===base)return overviewPage(await supervisionOverview(env,current))
  if(path===base+'/settings'){owner(current);return settingsPage(await supervisionOverview(env,current))}
  const queue=path.match(/^\/app\/supervision\/queues\/([^/]+)(\/(tv|live))?$/)
  if(queue){
   const snapshot=await queueSnapshot(env,current,queue[1]),timeline=await queueTimeline(env,current,queue[1])
   if(queue[3]==='live')return new Response(snapshot.status==='current'?liveBody(snapshot,timeline):null,{status:snapshot.status==='current'?200:503,headers:{...headers,'content-type':'text/html; charset=utf-8'}})
   return wallboardPage(snapshot,timeline,queue[3]==='tv')
  }
  throw new Fault('not_found',404)
 }
 if(request.method!=='POST')throw new Fault('method_not_allowed',405)
 const raw=data??await input(request),value={...raw}
 if(path===base+'/grants'){
  owner(current)
  value.canIntervene=raw.canIntervene==='true';value.expiresAt=Date.parse(String(raw.expiresAt)+'Z')
  try{await issueGrant(env,current,value);return redirect(base+'/settings')}
  catch(error){if(!(error instanceof Fault))throw error;return settingsPage(await supervisionOverview(env,current),error.code)}
 }
 const revoke=path.match(/^\/app\/supervision\/grants\/([^/]+)\/revoke$/)
 if(revoke){keys(value,[]);await revokeGrant(env,current,revoke[1]);return redirect(base+'/settings')}
 const state=path.match(/^\/app\/supervision\/queues\/([^/]+)\/agents\/([^/]+)\/state$/)
 if(state){
  value.revision=Number(value.revision)
  try{await intervene(env,current,state[1],state[2],value);return redirect(base+'/queues/'+state[1])}
  catch(error){
   if(!(error instanceof Fault)||error.status===403)throw error
   return wallboardPage(await queueSnapshot(env,current,state[1]),await queueTimeline(env,current,state[1]),false,error.code)
  }
 }
 throw new Fault('not_found',404)
}
