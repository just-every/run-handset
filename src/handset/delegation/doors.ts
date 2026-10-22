import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { approveControl, executeControl, reconcileControl } from './controls'
import { commit } from '../audit/store'
import { Fault, escape as e, consolePage, integer, json, keys, owner, text, type ObjectValue } from '../core'
import { configureLine, createDelegation, delegated, intent, linePolicy, presence, revokeDelegation, sql, type Line } from './store'
import { deskPage, type Desk } from './pages'

export async function desk(env:Bindings,actor:Session):Promise<Desk>{
 const isOwner=actor.operator.role==='owner',now=Date.now()
 const rows=(await sql(env,`SELECT l.*,p.display_name AS principal_name,json_extract(n.data,'$.e164') AS e164 FROM hnd_frontdesk_lines l JOIN oa_operators p ON p.id=l.principal_id JOIN hnd_records n ON n.id=l.number_id ${isOwner?'':'WHERE EXISTS(SELECT 1 FROM hnd_delegations d WHERE d.line_id=l.id AND d.assistant_id=?)'} ORDER BY l.id`,...isOwner?[]:[actor.operator.id]).all<Line&{principal_name:string;e164:string}>()).results
 const lines:Desk['lines']=[]
 for(const l of rows){
  const grants=(await sql(env,'SELECT id FROM hnd_delegations WHERE line_id=? AND assistant_id=? ORDER BY created_at DESC',l.id,actor.operator.id).all<{id:string}>()).results
  let delegationId:string|null=null
  for(const g of grants){try{await delegated(env,actor,g.id);delegationId=g.id;break}catch{/* no current grant */}}
  if(!isOwner&&!delegationId)continue
  const state=await sql(env,'SELECT * FROM hnd_frontdesk_presence WHERE operator_id=?',l.principal_id).first<{state:string;observed_at:number}>()
  lines.push({...l,delegation_id:delegationId,policy:linePolicy(l),presence:state&&now-state.observed_at<=90000?state.state:'unknown',observed_at:state?.observed_at??null})
 }
 const calls:Desk['calls']=[]
 for(const sourceId of new Set(lines.map(l=>l.source_id))){const found=(await sql(env,"SELECT r.id,rs.source_id,r.data FROM hnd_records r JOIN hnd_record_sources rs ON rs.record_id=r.id WHERE r.kind='call_session' AND rs.source_id=? ORDER BY r.received_at DESC LIMIT 50",sourceId).all<Desk['calls'][number]>()).results;calls.push(...found)}
 const operations=(await sql(env,'SELECT id,actor,principal,kind,state,created_at,call_id,target,line_revision FROM hnd_frontdesk_operations WHERE (?=1 OR actor=(SELECT pseudonym FROM hnd_actor_refs WHERE operator_id=?)) ORDER BY created_at DESC LIMIT 50',isOwner?1:0,actor.operator.id).all<Desk['operations'][number]>()).results
 const people=isOwner?(await sql(env,"SELECT id,display_name FROM oa_operators WHERE status='active' ORDER BY display_name").all<Desk['people'][number]>()).results:[]
 const sources=isOwner?(await sql(env,'SELECT id,number_id FROM hnd_sources WHERE revoked_at IS NULL').all<Desk['sources'][number]>()).results:[]
 const ownPresence=await sql(env,'SELECT state,revision FROM hnd_frontdesk_presence WHERE operator_id=?',actor.operator.id).first<{state:string;revision:number}>()
 await commit(env,actor,'delegation.read','installation','completed',[],false)
 return {lines,calls,operations,people,sources,ownPresence}
}
export async function delegationDoor(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response|null>{
 const path=new URL(request.url).pathname,html=path.startsWith('/app/'),base=html?'/app/front-desk':'/api/handset/front-desk'
 if(path!==base&&!path.startsWith(base+'/'))return null
 if(request.method==='GET'&&path===base){keys(Object.fromEntries(new URL(request.url).searchParams),[]);const result=await desk(env,actor);return html?deskPage(result,actor.operator.role==='owner'):json(result)}
 if(request.method!=='POST')throw new Fault('method_not_allowed',405)
 const v={...value}
 if(html){for(const key of ['revision','lineRevision','dnd','maxSeconds'])if(typeof v[key]==='string')v[key]=v[key]===''?undefined:Number(v[key]);if(typeof v.weekdays==='string')v.weekdays=v.weekdays.split(',').map(Number);if(typeof v.expiresAt==='string')v.expiresAt=new Date(v.expiresAt+'Z').getTime();for(const k of ['id','revision','callId','target','forwardTo','listId'])if(v[k]===''||v[k]===undefined)delete v[k]}
 let result:unknown,status=200
 if(path===base+'/lines'){result=await configureLine(env,actor,v);status=201}
 else if(path===base+'/delegations'){result=await createDelegation(env,actor,v);status=201}
 else if(path===base+'/revoke'){owner(actor);keys(v,['delegationId']);result=await revokeDelegation(env,actor,text(v.delegationId,'delegationId'))}
 else if(path===base+'/presence'){if(html)v.revision=integer(Number(v.revision),'revision',0);result=await presence(env,actor,v)}
 else if(path===base+'/operations'){result=await intent(env,actor,v);status=202}
 else if(path===base+'/approve')result=await approveControl(env,actor,v)
 else if(path===base+'/execute'){result=await executeControl(env,actor,v);status=202}
 else if(path===base+'/reconcile')result=await reconcileControl(env,actor,v)
 else throw new Fault('not_found',404)
 if(!html)return json(result,status)
 if(path===base+'/execute'||path===base+'/reconcile')return consolePage('Call control observation',`<p role="status">${e(JSON.stringify(result))}</p><a href="/app/front-desk">Return to front desk</a>`,status)
 if(path===base+'/operations')return consolePage('Call request held / Solicitud pendiente','<p role="status">No call effect occurred. Qualified media endpoints and exact spend approval are required before dialing or changing audio. This request retains the assistant actor, executive principal and approved business-number reference.</p><a href="/app/front-desk">Return to front desk</a>',202)
 return new Response(null,{status:303,headers:{location:'/app/front-desk','cache-control':'no-store'}})
}
