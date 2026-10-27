import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { choice, Fault, id, integer, json, keys, owner, text, type ObjectValue } from '../core'

interface Box { id:string; name:string; kind:'personal'|'shared'; owner_id:string }
interface Item { id:string; box_id:string; source_id:string; transcript:string; language:string; assigned_to:string|null; state:'open'|'handled'; revision:number }
const accessSql=`EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id JOIN hnd_voicemail_boxes b ON b.id=?
 WHERE s.id=? AND s.operator_id=? AND s.operator_version=o.version AND o.status='active' AND s.revoked_at IS NULL AND s.expires_at>?
 AND (b.owner_id=o.id OR (b.kind='shared' AND EXISTS(SELECT 1 FROM hnd_voicemail_members m WHERE m.box_id=b.id AND m.operator_id=o.id AND m.active=1))))`
const accessArgs=(actor:Session,boxId:string)=>[boxId,actor.id,actor.operator.id,Date.now()]
async function box(env:Bindings,actor:Session,boxId:string){
 const b=await env.DB.prepare(`SELECT * FROM hnd_voicemail_boxes WHERE id=? AND ${accessSql}`).bind(boxId,...accessArgs(actor,boxId)).first<Box>()
 if(!b)throw new Fault('mailbox_not_found',404)
 return b
}
const accessFence=(env:Bindings,actor:Session,boxId:string)=>env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT CASE WHEN ${accessSql} THEN 1 ELSE 0 END`).bind(...accessArgs(actor,boxId))
export async function voicemailDoor(request:Request,env:Bindings,actor:Session,data?:ObjectValue):Promise<Response>{
 const url=new URL(request.url),tail=url.pathname.slice('/api/handset/voicemail'.length),db=env.DB,v=data??{}
 if(request.method==='GET'&&tail===''){
  const candidates=(await db.prepare('SELECT id FROM hnd_voicemail_boxes ORDER BY id').all<{id:string}>()).results
  const boxes:Box[]=[]
  for(const c of candidates){try{boxes.push(await box(env,actor,c.id))}catch(error){if(!(error instanceof Fault))throw error}}
  return json({boxes,captureQualified:false})
 }
 if(request.method==='POST'&&tail===''){
  owner(actor);keys(v,['name','kind']);const boxId=id(),kind=choice(v.kind,['personal','shared'] as const,'kind')
  await commit(env,actor,'voicemail.create',boxId,'completed',[db.prepare('INSERT INTO hnd_voicemail_boxes VALUES(?,?,?,?)').bind(boxId,text(v.name,'name'),kind,actor.operator.id)])
  return json({box:await box(env,actor,boxId)},201)
 }
 const match=tail.match(/^\/([^/]+)(?:\/(members|observations|items)(?:\/([^/]+)(?:\/(claim|handled|reopen))?)?)?$/)
 if(!match)throw new Fault('not_found',404)
 const b=await box(env,actor,match[1]),action=match[2]
 if(request.method==='GET'&&!action){
  const items=(await db.prepare('SELECT * FROM hnd_voicemail_items WHERE box_id=? ORDER BY id').bind(b.id).all<Item>()).results
  // Recheck current membership in the same transaction as the read receipt.
  await commit(env,actor,'voicemail.read',b.id,'completed',[accessFence(env,actor,b.id)],false)
  return json({box:b,items,due:items.filter(i=>i.state==='open').map(i=>i.id),captureQualified:false,transcriptionQualified:false})
 }
 if(request.method==='GET'&&action==='items'&&match[3]&&!match[4]){
  const item=await db.prepare('SELECT * FROM hnd_voicemail_items WHERE id=? AND box_id=?').bind(match[3],b.id).first<Item>()
  if(!item)throw new Fault('voicemail_not_found',404)
  const history=(await db.prepare('SELECT * FROM hnd_voicemail_history WHERE item_id=? ORDER BY revision').bind(item.id).all()).results
  await commit(env,actor,'voicemail.read',item.id,'completed',[accessFence(env,actor,b.id)],false)
  return json({item,history,captureQualified:false,transcriptionQualified:false})
 }
 if(request.method!=='POST')throw new Fault('method_not_allowed',405)
 if(action==='members'){
  owner(actor);if(b.owner_id!==actor.operator.id||b.kind!=='shared')throw new Fault('shared_box_owner_required',403)
  keys(v,['operatorId','active']);if(typeof v.active!=='boolean')throw new Fault('invalid_active')
  const operatorId=text(v.operatorId,'operatorId')
  if(v.active&&!await db.prepare("SELECT id FROM oa_operators WHERE id=? AND status='active'").bind(operatorId).first())throw new Fault('active_member_required',409)
  await commit(env,actor,'voicemail.membership',b.id,'completed',[accessFence(env,actor,b.id),db.prepare('INSERT INTO hnd_voicemail_members VALUES(?,?,?) ON CONFLICT(box_id,operator_id) DO UPDATE SET active=excluded.active').bind(b.id,operatorId,v.active?1:0)])
  return json({updated:true})
 }
 if(action==='observations'){
  owner(actor);if(b.owner_id!==actor.operator.id)throw new Fault('box_owner_required',403)
  keys(v,['sourceId','transcript','language','confirm'])
  if(v.confirm!=='record supplied text without capture qualification')throw new Fault('supplied_text_confirmation_required')
  const sourceId=text(v.sourceId,'sourceId'),transcript=text(v.transcript,'transcript',20000),language=choice(v.language,['en','es'] as const,'language')
  const existing=await db.prepare('SELECT * FROM hnd_voicemail_items WHERE box_id=? AND source_id=?').bind(b.id,sourceId).first<Item>()
  if(existing){if(existing.transcript!==transcript||existing.language!==language)throw new Fault('source_conflict',409);return json({item:existing,replay:true,captureQualified:false,transcriptionQualified:false},200)}
  const itemId=id()
  await commit(env,actor,'voicemail.observe',itemId,'completed',[accessFence(env,actor,b.id),db.prepare("INSERT INTO hnd_voicemail_items VALUES(?,?,?,?,?,NULL,'open',1,?,?)").bind(itemId,b.id,sourceId,transcript,language,actor.operator.id,Date.now())])
  return json({item:await db.prepare('SELECT * FROM hnd_voicemail_items WHERE id=?').bind(itemId).first<Item>(),captureQualified:false,transcriptionQualified:false},201)
 }
 if(action==='items'&&match[3]&&match[4]){
  keys(v,['revision']);const item=await db.prepare('SELECT * FROM hnd_voicemail_items WHERE id=? AND box_id=?').bind(match[3],b.id).first<Item>()
  if(!item)throw new Fault('voicemail_not_found',404)
  const revision=integer(v.revision,'revision',1),verb=match[4]
  if(revision!==item.revision)throw new Fault('version_conflict',409)
  if(verb==='claim'&&(item.assigned_to!==null||item.state!=='open'))throw new Fault('already_claimed_or_handled',409)
  if(verb!=='claim'&&item.assigned_to!==actor.operator.id&&b.owner_id!==actor.operator.id)throw new Fault('claim_owner_required',403)
  if(verb==='handled'&&item.state!=='open'||verb==='reopen'&&item.state!=='handled')throw new Fault('wrong_voicemail_state',409)
  const assigned=verb==='claim'?actor.operator.id:item.assigned_to,state=verb==='handled'?'handled':'open'
  await commit(env,actor,'voicemail.'+verb,item.id,'completed',[accessFence(env,actor,b.id),
   db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_voicemail_items WHERE id=? AND revision=? AND assigned_to IS ? AND state=?').bind(item.id,revision,item.assigned_to,item.state),
   db.prepare('UPDATE hnd_voicemail_items SET assigned_to=?,state=?,revision=revision+1,actor_id=?,updated_at=? WHERE id=?').bind(assigned,state,actor.operator.id,Date.now(),item.id)],false)
  return json({item:await db.prepare('SELECT * FROM hnd_voicemail_items WHERE id=?').bind(item.id).first<Item>()})
 }
 throw new Fault('not_found',404)
}
