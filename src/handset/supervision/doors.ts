import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, input, json, keys, session, type ObjectValue } from '../core'
import { issueGrant, revokeGrant } from './authority'
import { callControl, intervene, queueSnapshot, queueTimeline, supervisionOverview } from './store'

export async function supervisionDoor(request:Request,original:Bindings,actor:Session,data?:ObjectValue):Promise<Response|null>{
 const url=new URL(request.url),base='/api/handset/supervision',path=url.pathname
 if(path!==base&&!path.startsWith(base+'/'))return null
 const checked=await session(request,original)
 if(checked.session.id!==actor.id)throw new Fault('session_mismatch',403)
 const {env,session:current}=checked,action=path.slice(base.length)
 keys(Object.fromEntries(url.searchParams),[])
 if(request.method==='GET'){
  if(action===''||action==='/overview')return json(await supervisionOverview(env,current))
  const queue=action.match(/^\/queues\/([^/]+)(\/timeline)?$/)
  if(queue)return json(queue[2]?await queueTimeline(env,current,queue[1]):await queueSnapshot(env,current,queue[1]))
  throw new Fault('not_found',404)
 }
 if(request.method!=='POST')throw new Fault('method_not_allowed',405)
 const value=data??await input(request)
 if(action==='/grants')return json(await issueGrant(env,current,value),201)
 const revoke=action.match(/^\/grants\/([^/]+)\/revoke$/)
 if(revoke){keys(value,[]);return json(await revokeGrant(env,current,revoke[1]))}
 const agent=action.match(/^\/queues\/([^/]+)\/agents\/([^/]+)\/state$/)
 if(agent)return json(await intervene(env,current,agent[1],agent[2],value))
 const control=action.match(/^\/queues\/([^/]+)\/calls\/([^/]+)\/([^/]+)$/)
 if(control)return json(await callControl(env,current,control[1],control[2],control[3],value))
 throw new Fault('not_found',404)
}
