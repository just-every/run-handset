import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { choice, consolePage, escape as e, Fault, hidden, input, integer, json, keys, type ObjectValue } from '../core'
import { presence } from './configuration'
import { agent, event, guard, statement, write } from './storage'

/** A native session can change only its own existing staffing assignments.
 * No new memberships, routing preferences, capabilities or caller data. */
export async function selfService(request:Request,env:Bindings,actor:Session,base:string,data?:ObjectValue){
 const path=new URL(request.url).pathname,html=base.startsWith('/app/'),target=actor.operator.id
 const fence=()=>[env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id WHERE s.id=? AND s.operator_id=? AND s.operator_version=o.version AND o.status='active' AND s.revoked_at IS NULL AND s.expires_at>?`).bind(actor.id,target,Date.now())]
 const ctx={env,actor,selfService:true,fences:fence}
 if(request.method==='GET'&&path!==base+'/self'||request.method==='POST'&&path!==base+'/presence'&&path!==base+'/wrap'&&!new RegExp('^'+base+'/[^/]+/memberships$').test(path))throw new Fault('owner_required',403)
 const current=await agent(ctx,target)
 if(request.method==='GET'){
  if(path!==base+'/self')throw new Fault('owner_required',403)
  keys(Object.fromEntries(new URL(request.url).searchParams),[])
  const memberships=(await statement(ctx,'SELECT m.*,q.name FROM hnd_queue_memberships m JOIN hnd_queues q ON q.id=m.queue_id WHERE m.operator_id=? ORDER BY q.name',target).all<{queue_id:string;name:string;logged_in:number;revision:number}>()).results
  if(!html)return json({agent:current,memberships})
  return consolePage('My queue state',`<p>Availability, queue login and wrap-up are independent. These controls preserve active calls.</p><h2>Availability</h2><form method="post" action="${base}/presence">${hidden('revision',current.revision)}<label for="self-availability">Availability</label><select id="self-availability" name="availability">${['available','busy','away','offline'].map(a=>`<option ${a===current.availability?'selected':''}>${a}</option>`).join('')}</select><button>Update my availability</button></form><h2>My queues</h2>${memberships.map(m=>`<section><h3>${e(m.name)}</h3><p>${m.logged_in?'Logged in':'Logged out'}</p><form method="post" action="${base}/${e(m.queue_id)}/memberships">${hidden('revision',m.revision)}${hidden('loggedIn',m.logged_in?0:1)}<button>${m.logged_in?'Log out of ':'Log into '}${e(m.name)}</button></form></section>`).join('')}<h2>Wrap-up</h2><p>${current.wrap_until>Date.now()?'Wrapping until '+e(new Date(current.wrap_until).toISOString()):'No wrap-up'}</p><form method="post" action="${base}/wrap">${hidden('revision',current.revision)}<label for="self-wrap">Wrap-up seconds</label><input id="self-wrap" name="seconds" type="number" min="0" max="3600" value="30" required><button>Set my wrap-up</button></form>`)
 }
 if(request.method!=='POST')throw new Fault('method_not_allowed',405)
 const v=data??await input(request)
 if(v.operatorId!==undefined&&v.operatorId!==target)throw new Fault('self_service_only',403)
 for(const k of ['revision','loggedIn','seconds'])if(html&&typeof v[k]==='string')v[k]=Number(v[k])
 let result:unknown
 if(path===base+'/presence')result=await presence(ctx,{...v,operatorId:target})
 else if(path===base+'/wrap'){
  keys(v,['operatorId','seconds','revision']);const seconds=integer(v.seconds,'seconds',0,3600),revision=integer(v.revision,'revision',1)
  await write(ctx,'installation',[guard(ctx,'SELECT count(*) FROM hnd_queue_agents WHERE operator_id=? AND revision=?',target,revision),statement(ctx,'UPDATE hnd_queue_agents SET wrap_until=?,revision=revision+1 WHERE operator_id=?',Date.now()+seconds*1000,target),event(ctx,'agent.wrap',null,null,target,{seconds})]);result=await agent(ctx,target)
 }else{
  const m=path.match(new RegExp('^'+base+'/([^/]+)/memberships$'))
  if(!m)throw new Fault('owner_required',403)
  keys(v,['operatorId','loggedIn','revision','confirm','priority'])
  const membership=await statement(ctx,'SELECT priority FROM hnd_queue_memberships WHERE queue_id=? AND operator_id=?',m[1],target).first<{priority:number}>()
  if(!membership||v.priority!==undefined&&v.priority!==membership.priority)throw new Fault('existing_membership_required',403)
  const loggedIn=integer(v.loggedIn,'loggedIn',0,1),revision=integer(v.revision,'revision',1)
  await write(ctx,m[1],[guard(ctx,'SELECT count(*) FROM hnd_queue_memberships WHERE queue_id=? AND operator_id=? AND revision=?',m[1],target,revision),statement(ctx,'UPDATE hnd_queue_memberships SET logged_in=?,revision=revision+1,updated_at=? WHERE queue_id=? AND operator_id=?',loggedIn,Date.now(),m[1],target),event(ctx,'membership.self_changed',m[1],null,target,{loggedIn})]);result={loggedIn}
 }
 return html?new Response(null,{status:303,headers:{location:base+'/self','cache-control':'no-store'}}):json(result)
}
