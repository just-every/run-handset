import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, id, integer, keys, type ObjectValue } from '../core'
import { guard, type ConsentPolicy } from '../consent/store'
import { mediaList } from './model'
import { thread, job, custodyFence, permission, permissionFence, sourceFence } from './store'
import { noStopFence, requireNoStop } from './suppression'
export async function schedule(env:Bindings,actor:Session,key:string,v:ObjectValue) {
 keys(v,['revision','snippetId','snippetRevision','dueAt','permissionId','media','participants'])
 if(v.participants!==undefined)throw new Fault('group_route_unqualified',409)
 const {row:t,source}=await thread(env,key)
 if(t.revision!==v.revision||t.owner_id!==actor.operator.id||t.custody!=='handset')throw new Fault('thread_custody_changed',409)
 const snippet=await env.DB.prepare('SELECT * FROM hnd_message_snippets WHERE id=? AND revision=?').bind(v.snippetId as string,v.snippetRevision as number).first<{id:string;body:string}>()
 if(!snippet)throw new Fault('snippet_revision_changed',409)
 const p=await permission(env,String(v.permissionId),t.peer);await requireNoStop(env,[t.peer])
 const media=mediaList(v.media)
 for(const m of media) {
  const native=await env.DB.prepare(`SELECT 1 FROM hnd_records r JOIN hnd_record_sources rs ON rs.record_id=r.id WHERE rs.source_id=? AND r.kind='media' AND json_extract(r.data,'$.providerUrl')=?`).bind(t.source_id,m.url).first()
  if(!native||!m.url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${source.account_id}/Messages/`))throw new Fault('native_same_source_media_required',403)
 }
 const due=integer(v.dueAt,'dueAt',Date.now(),Date.now()+30*86400000),keyId=id()
 await commit(env,actor,'message.schedule',keyId,'completed',[sourceFence(env,source),custodyFence(env,t,actor.operator.id),permissionFence(env,p.id,t.peer),noStopFence(env,t.peer),env.DB.prepare(`INSERT INTO hnd_message_jobs(id,thread_id,permission_id,snippet_id,body,media,due_at,state,reason,created_by,owner_version,thread_revision,created_at) VALUES (?,?,?,?,?,?,?,'draft','Exact draft requires separate approval',?,?,?,?)`).bind(keyId,t.id,p.id,snippet.id,snippet.body,JSON.stringify(media),due,actor.operator.id,actor.operator.version,t.revision,Date.now())])
 return {job:await job(env,keyId)}
}
export async function approve(env:Bindings,actor:Session,key:string,v:ObjectValue) {
 keys(v,['revision','confirm'])
 if(v.confirm!=='approve exact scheduled message')throw new Fault('exact_message_approval_required',403)
 const j=await job(env,key),{row:t,source}=await thread(env,j.thread_id)
 if(j.state!=='draft'||j.revision!==v.revision||j.created_by!==actor.operator.id||j.owner_version!==actor.operator.version||j.thread_revision!==t.revision||t.owner_id!==actor.operator.id||t.custody!=='handset')throw new Fault('message_revision_or_custody_changed',409)
 await permission(env,j.permission_id,t.peer);await requireNoStop(env,[t.peer])
 const p=await env.DB.prepare('SELECT * FROM hnd_consent_policies WHERE source_id=? ORDER BY revision DESC LIMIT 1').bind(source.id).first<ConsentPolicy>()
 if(!p)throw new Fault('reviewed_consent_policy_required',409)
 await commit(env,actor,'message.approve',key,'completed',[sourceFence(env,source),custodyFence(env,t,actor.operator.id),permissionFence(env,j.permission_id,t.peer),noStopFence(env,t.peer),guard(env,"SELECT count(*) FROM hnd_message_jobs WHERE id=? AND state='draft' AND revision=?",key,j.revision),env.DB.prepare("UPDATE hnd_message_jobs SET state='queued',reason='Exact message approved; current send gates apply when due',policy_id=?,approved_at=?,revision=revision+1 WHERE id=?").bind(p.id,Date.now(),key)])
 return {job:await job(env,key)}
}
