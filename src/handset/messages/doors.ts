import { bindGroup } from './groups'
import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { choice, Fault, id, integer, json, keys, owner, text, type ObjectValue } from '../core'
import { activeSourceById, sourceFence } from '../providers/sources'
import { guard } from '../consent/store'
import { messageBody, phone, route, type Thread } from './model'
import { thread, job, groupThreadFence } from './store'
import { suppression } from './suppression'
import { approve, schedule } from './scheduling'
import { dispatchMessage, refreshMessage } from './provider'
import { messageConsole } from './console'

async function snapshot(env:Bindings,actor:Session) {
 const sources=(await env.DB.prepare('SELECT id FROM hnd_sources').all<{id:string}>()).results
 const active=(await Promise.all(sources.map(s=>activeSourceById(env,s.id)))).filter(s=>s!==null)
 const ids=JSON.stringify(active.map(s=>s.id))
 const threads=(await env.DB.prepare(`SELECT t.*,o.display_name AS owner_name FROM hnd_message_threads t LEFT JOIN oa_operators o ON o.id=t.owner_id WHERE t.source_id IN (SELECT value FROM json_each(?)) AND (t.route_kind='programmable' OR EXISTS(SELECT 1 FROM hnd_message_group_routes g JOIN oa_operators o ON o.id=g.approved_by WHERE g.source_id=t.source_id AND t.peer='group:'||g.conversation_sid AND g.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=g.owner_version)) ORDER BY t.updated_at DESC,t.id LIMIT 200`).bind(ids).all()).results
 const [snippets,permissions,jobs,stops]=await Promise.all([
  env.DB.prepare('SELECT * FROM hnd_message_snippets ORDER BY created_at DESC,id LIMIT 200').all(),
  env.DB.prepare('SELECT * FROM hnd_message_permissions ORDER BY created_at DESC,id LIMIT 200').all(),
  env.DB.prepare('SELECT * FROM hnd_message_jobs WHERE thread_id IN (SELECT id FROM hnd_message_threads WHERE source_id IN (SELECT value FROM json_each(?))) ORDER BY created_at DESC,id LIMIT 200').bind(ids).all(),
  env.DB.prepare("SELECT DISTINCT recipient FROM hnd_protection_stops WHERE channel IN ('sms','all') OR reason='dnc' LIMIT 200").all(),
 ])
 await commit(env,actor,'message.read','installation','completed',[...active.map(s=>sourceFence(env,s)),...threads.map(t=>groupThreadFence(env,String(t.id)))])
 const groupRoutes=(await env.DB.prepare('SELECT * FROM hnd_message_group_routes WHERE source_id IN (SELECT value FROM json_each(?)) AND revoked_at IS NULL').bind(ids).all()).results
 return {actorId:actor.operator.id,groupRoutes,threads,routes:active.map(s=>route(s.id,s.e164)),snippets:snippets.results,permissions:permissions.results,jobs:jobs.results,stops:stops.results,bounded:true}
}
async function detail(env:Bindings,actor:Session,key:string) {
 const {row,source}=await thread(env,key)
 const [messages,jobs,history,person]=await Promise.all([
  env.DB.prepare('SELECT * FROM hnd_inbox_messages WHERE thread_id=? ORDER BY occurred_at,id LIMIT 200').bind(key).all(),
  env.DB.prepare('SELECT * FROM hnd_message_jobs WHERE thread_id=? ORDER BY created_at,id LIMIT 200').bind(key).all(),
  env.DB.prepare("SELECT h.event,COALESCE(o.display_name,'Provider') AS actor_name,h.occurred_at FROM hnd_message_history h LEFT JOIN oa_operators o ON o.id=h.actor_id WHERE h.thread_id=? ORDER BY h.occurred_at,h.rowid LIMIT 200").bind(key).all(),
  env.DB.prepare('SELECT display_name FROM oa_operators WHERE id=?').bind(row.owner_id).first<{display_name:string}>(),
 ])
 await commit(env,actor,'message.read',key,'completed',[sourceFence(env,source),groupThreadFence(env,key)])
 return {thread:{...row,owner_name:person?.display_name??null},messages:messages.results,jobs:jobs.results,history:history.results,bounded:true}
}
async function changeCustody(env:Bindings,actor:Session,key:string,action:string,v:ObjectValue) {
 keys(v,action==='claim'?['revision']:['revision','custody'])
 const {row:t,source}=await thread(env,key)
 if(integer(v.revision,'revision',1)!==t.revision)throw new Fault('thread_revision_changed',409)
 if(action==='claim') {
  if(t.owner_id||t.custody!=='handset')throw new Fault('thread_already_claimed',409)
 }else if(t.custody==='handset'&&t.owner_id!==actor.operator.id)throw new Fault('thread_owner_required',403)
 const custody=action==='claim'?'handset':choice(v.custody,['handset','happytohelp'],'custody'),newOwner=action==='claim'?actor.operator.id:null
 await commit(env,actor,'message.claim',key,'completed',[sourceFence(env,source),groupThreadFence(env,key),guard(env,'SELECT count(*) FROM hnd_message_threads WHERE id=? AND revision=? AND owner_id IS ? AND custody=?',key,t.revision,t.owner_id,t.custody),env.DB.prepare('UPDATE hnd_message_threads SET owner_id=?,custody=?,revision=revision+1,updated_at=? WHERE id=?').bind(newOwner,custody,Date.now(),key),env.DB.prepare('INSERT INTO hnd_message_history VALUES (?,?,?,?,?)').bind(id(),key,action==='claim'?'Conversation claimed':custody==='happytohelp'?'Support custody recorded for HappyToHelp; native sends fenced':'Returned to unclaimed Handset inbox',actor.operator.id,Date.now()),env.DB.prepare("UPDATE hnd_message_jobs SET state='suppressed',reason='Thread custody changed; fresh draft approval required',revision=revision+1 WHERE thread_id=? AND state IN ('draft','queued')").bind(key)])
 return detail(env,actor,key)
}
export async function messageDoor(request:Request,env:Bindings,actor:Session,v?:ObjectValue):Promise<Response|null> {
 owner(actor)
 const html=await messageConsole(request,env,actor,messageDoor,v);if(html)return html
 const url=new URL(request.url),base='/api/handset/messages',path=url.pathname.slice(base.length)
 if(!url.pathname.startsWith(base))return null
 if(request.method==='GET') {
  if(path==='')return json(await snapshot(env,actor))
  if(path==='/suppression'){keys(Object.fromEntries(url.searchParams),['recipient']);return json(await suppression(env,phone(url.searchParams.get('recipient'))))}
  if(path==='/thread-suppression'){keys(Object.fromEntries(url.searchParams),['threadId']);const {row:t}=await thread(env,text(url.searchParams.get('threadId'),'threadId'));const recipients=t.route_kind==='conversations'?(JSON.parse(t.participants) as string[]).filter(p=>p!==t.business):[t.peer];const results=await Promise.all(recipients.map(p=>suppression(env,p)));return json({suppressed:results.some(r=>r.suppressed),requiredReplyPolicy:'provider-managed-only'})}
  const match=path.match(/^\/threads\/([0-9a-f-]{36})$/)
  if(match)return json(await detail(env,actor,match[1]))
  throw new Fault('not_found',404)
 }
 if(request.method!=='POST'||!v)throw new Fault('method_not_allowed',405)
 if(url.search)throw new Fault('unexpected_message_query')
 const groupRevoke=path.match(/^\/group-routes\/([0-9a-f-]{36})\/revoke$/)
 if(groupRevoke){keys(v,[]);await commit(env,actor,'message.permission',groupRevoke[1],'completed',[guard(env,'SELECT count(*) FROM hnd_message_group_routes WHERE id=?',groupRevoke[1]),env.DB.prepare('UPDATE hnd_message_group_routes SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(Date.now(),groupRevoke[1])]);return json({revoked:true})}
 if(path==='/group-routes')return json(await bindGroup(env,actor,v),201)
 if(path==='/snippets') {
  keys(v,['name','body']);const key=id()
  await commit(env,actor,'message.snippet',key,'completed',[env.DB.prepare('INSERT INTO hnd_message_snippets VALUES (?,?,?,1,?,?)').bind(key,text(v.name,'name',100),messageBody(v.body),actor.operator.id,Date.now())])
  return json({snippet:await env.DB.prepare('SELECT * FROM hnd_message_snippets WHERE id=?').bind(key).first()},201)
 }
 if(path==='/permissions') {
  keys(v,['recipient','purpose','evidence','expiresAt','confirm'])
  if(v.purpose!=='customer-care'||v.confirm!=='I verified explicit permission for customer-care texts')throw new Fault('explicit_customer_care_permission_required',403)
  const recipient=phone(v.recipient),key=id(),expires=integer(v.expiresAt,'expiresAt',Date.now()+1000,Date.now()+90*86400000)
  if((await suppression(env,recipient)).suppressed)throw new Fault('recipient_STOP_or_DNC',409)
  await commit(env,actor,'message.permission',key,'completed',[env.DB.prepare("INSERT INTO hnd_message_permissions VALUES (?,?,'customer-care',?,?,?,?,?,NULL)").bind(key,recipient,text(v.evidence,'evidence',3000),actor.operator.id,actor.operator.version,Date.now(),expires)])
  return json({permission:await env.DB.prepare('SELECT * FROM hnd_message_permissions WHERE id=?').bind(key).first(),marketingEnrollment:false},201)
 }
 const revoke=path.match(/^\/permissions\/([0-9a-f-]{36})\/revoke$/)
 if(revoke) {
  keys(v,[])
  await commit(env,actor,'message.permission',revoke[1],'completed',[guard(env,'SELECT count(*) FROM hnd_message_permissions WHERE id=?',revoke[1]),env.DB.prepare('UPDATE hnd_message_permissions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(Date.now(),revoke[1]),env.DB.prepare("UPDATE hnd_message_jobs SET state='suppressed',reason='Explicit permission revoked',revision=revision+1 WHERE permission_id=? AND state IN ('draft','queued')").bind(revoke[1])])
  return json({revoked:true})
 }
 const t=path.match(/^\/threads\/([0-9a-f-]{36})\/(claim|handoff|schedule)$/)
 if(t)return json(t[2]==='schedule'?await schedule(env,actor,t[1],v):await changeCustody(env,actor,t[1],t[2],v),t[2]==='schedule'?201:200)
 const j=path.match(/^\/jobs\/([0-9a-f-]{36})\/(approve|cancel|dispatch|refresh)$/)
 if(j) {
  if(j[2]==='approve')return json(await approve(env,actor,j[1],v))
  const current=await job(env,j[1]),{row:own,source}=await thread(env,current.thread_id)
  if(j[2]==='refresh'){keys(v,[]);return json({job:await refreshMessage(env,current.id)})}
  keys(v,['revision'])
  if(current.revision!==v.revision)throw new Fault('message_revision_changed',409)
  if(current.created_by!==actor.operator.id||own.owner_id!==actor.operator.id)throw new Fault('thread_owner_required',403)
  if(j[2]==='dispatch')return json({job:await dispatchMessage(env,current.id)})
  if(!['draft','queued'].includes(current.state))throw new Fault('message_not_cancelable',409)
  await commit(env,actor,'message.cancel',current.id,'completed',[sourceFence(env,source),guard(env,"SELECT count(*) FROM hnd_message_jobs WHERE id=? AND revision=? AND state IN ('draft','queued')",current.id,current.revision),env.DB.prepare("UPDATE hnd_message_jobs SET state='canceled',reason='Canceled by owner before submission',revision=revision+1 WHERE id=?").bind(current.id)])
  return json({job:await job(env,current.id)})
 }
 throw new Fault('not_found',404)
}
