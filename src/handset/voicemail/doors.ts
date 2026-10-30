import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { choice, Fault, id, integer, json, keys, owner, text, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import { nativeFence } from '../preparation/access'
export interface Box {id:string;owner_id:string;admin_id:string;kind:string;name:string;revision:number}
export interface Item {id:string;box_id:string;source_id:string;observation:string;language:string;claimant:string|null;state:string;revision:number}
export interface Capabilities {work:boolean;assign:boolean;admin:boolean;observe:boolean}
export interface BoxPerson {id:string;display_name:string;can_work:boolean;can_assign:boolean;is_owner:boolean}
export interface MailboxView {actorId:string;box:Box;items:Item[];due:string[];history:{id:string;item_id:string;actor:string;action:string;revision:number;created_at:number;note:string}[];capabilities:Capabilities;people:BoxPerson[]}
export type ListedBox=Box&{dueCount:number;capabilities:Capabilities}
const root='/api/handset/voicemail'
const ownerAccess=`(b.owner_id=? AND (b.kind='personal' OR (b.owner_id=b.admin_id AND ?='owner') OR EXISTS(SELECT 1 FROM hnd_mailbox_members om JOIN oa_operators op ON op.id=om.person_id JOIN oa_operators oi ON oi.id=om.issuer_id WHERE om.box_id=b.id AND om.person_id=b.owner_id AND om.can_work=1 AND op.status='active' AND op.version=om.person_version AND oi.status='active' AND oi.role='owner' AND oi.version=om.issuer_version)))`
const allowed=`SELECT b.* FROM hnd_mailboxes b WHERE b.id=? AND (${ownerAccess} OR (b.admin_id=? AND ?='owner') OR (b.kind<>'personal' AND EXISTS(SELECT 1 FROM hnd_mailbox_members m JOIN oa_operators p ON p.id=m.person_id JOIN oa_operators i ON i.id=m.issuer_id WHERE m.box_id=b.id AND m.person_id=? AND p.status='active' AND p.version=m.person_version AND i.status='active' AND i.role='owner' AND i.version=m.issuer_version)))`
type MailboxActor={operator:Pick<Session['operator'],'id'|'role'|'version'>}
const values=(a:MailboxActor,key:string)=>[key,a.operator.id,a.operator.role,a.operator.id,a.operator.role,a.operator.id]
const access=(env:Bindings,a:MailboxActor,key:string)=>env.DB.prepare(allowed).bind(...values(a,key))
const fence=(env:Bindings,a:MailboxActor,key:string)=>env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM ('+allowed+')').bind(...values(a,key))
const itemFence=(db:D1Database,item:Item)=>db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_voicemail_items WHERE id=? AND revision=?').bind(item.id,item.revision)
function operationSql(operation:'work'|'assign'){
 let query=allowed.replace('WHERE m.box_id=b.id AND',`WHERE m.can_${operation}=1 AND m.box_id=b.id AND`)
 if(operation==='assign')query=query.replace(ownerAccess+' OR ', '')
 return query
}
const operationQuery=(env:Bindings,a:Session,key:string,operation:'work'|'assign',guard=false)=>{
 const query=operationSql(operation),bound=operation==='work'?values(a,key):[key,a.operator.id,a.operator.role,a.operator.id]
 return env.DB.prepare(guard?'INSERT INTO hnd_guard(ok) SELECT count(*) FROM ('+query+')':query).bind(...bound)
}
async function targetWorker(env:Bindings,a:Session,key:string,person:string){
 const p=await env.DB.prepare("SELECT role,version FROM oa_operators WHERE id=? AND status='active'").bind(person).first<{role:Session['operator']['role'];version:number}>()
 if(!p)throw new Fault('active_person_required',409)
 const target={...a,operator:{...a.operator,id:person,role:p.role,version:p.version}}
 if(!await operationQuery(env,target,key,'work').first())throw new Fault('current_box_worker_required',403)
 return [operationQuery(env,target,key,'work',true),env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'").bind(person,p.version)]
}
async function requireOperation(env:Bindings,a:Session,key:string,operation:'work'|'assign'){
 if(!await operationQuery(env,a,key,operation).first())throw new Fault('mailbox_capability_required',403)
 return operationQuery(env,a,key,operation,true)
}
const presented=(item:Item)=>({...item,captureQualified:false,transcriptionQualified:false,outboundAuthority:false})
async function capabilities(env:Bindings,a:Session,box:Box):Promise<Capabilities>{
 const work=!!await operationQuery(env,a,box.id,'work').first()
 return {work,assign:box.kind!=='personal'&&!!await operationQuery(env,a,box.id,'assign').first(),admin:box.kind!=='personal'&&box.admin_id===a.operator.id&&a.operator.role==='owner',observe:work&&box.owner_id===a.operator.id}
}
async function people(env:Bindings,a:Session,box:Box):Promise<BoxPerson[]>{
 // Names come only from this box's current readers, never the company directory.
 const candidates=(await env.DB.prepare(`SELECT DISTINCT p.id,p.display_name,p.role,p.version FROM oa_operators p WHERE p.status='active' AND (
 p.id=? OR (?<>'personal' AND (p.id=? AND p.role='owner' OR EXISTS(SELECT 1 FROM hnd_mailbox_members m JOIN oa_operators i ON i.id=m.issuer_id WHERE m.box_id=? AND m.person_id=p.id AND m.person_version=p.version AND i.status='active' AND i.role='owner' AND i.version=m.issuer_version)))) ORDER BY p.display_name,p.id`).bind(box.owner_id,box.kind,box.admin_id,box.id).all<{id:string;display_name:string;role:Session['operator']['role'];version:number}>()).results
 const result:BoxPerson[]=[]
 for(const p of candidates){
  const target={...a,operator:{...a.operator,...p}}
  if(!await access(env,target,box.id).first())continue
  const caps=await capabilities(env,target,box)
  result.push({id:p.id,display_name:p.display_name,can_work:caps.work,can_assign:caps.assign,is_owner:p.id===box.owner_id})
 }
 return result
}
/** Exact-box checks for a queued recipient do not create a session or a grant. */
export async function mailboxDeliveryAccess(env:Bindings,personId:string,version:number,boxId:string,boxOwner=false){
 const p=await env.DB.prepare("SELECT id,role,version FROM oa_operators WHERE id=? AND version=? AND status='active'").bind(personId,version).first<MailboxActor['operator']>()
 if(!p)throw new Fault('current_mailbox_person_required',403)
 const a={operator:p},box=await access(env,a,boxId).first<Box>()
 if(!box||boxOwner&&box.owner_id!==personId)throw new Fault('mailbox_refused',403)
 const fences=()=>[fence(env,a,box.id),env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'").bind(personId,version),env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_mailboxes WHERE id=? AND revision=? AND owner_id=?').bind(box.id,box.revision,box.owner_id)]
 return {box,fences}
}
export async function voicemailDoor(request:Request,env:Bindings,a:Session,v?:ObjectValue):Promise<Response>{
 const delivery=await (await import('./delivery')).voicemailDeliveryDoor(request,env,a,v)
 if(delivery)return delivery
 const path=new URL(request.url).pathname.slice(root.length),db=env.DB
 if(request.method==='GET'&&path==='/boxes'){
  const boxes=(await db.prepare(allowed.replace('b.id=? AND ', '')+' ORDER BY b.name,b.id').bind(...values(a,'').slice(1)).all<Box>()).results
  const listed:ListedBox[]=[],guards=[nativeFence(db,a)]
  for(const box of boxes){
   const count=await db.prepare("SELECT count(*) AS n FROM hnd_voicemail_items WHERE box_id=? AND state='open'").bind(box.id).first<{n:number}>()
   listed.push({...box,dueCount:count!.n,capabilities:await capabilities(env,a,box)})
   guards.push(fence(env,a,box.id))
  }
  await commit(env,a,'voicemail.read','installation','completed',guards,false)
  return json({boxes:listed})
 }
 if(request.method==='POST'&&path==='/boxes'&&v){
  keys(v,['name','kind']);const kind=choice(v.kind,['personal','shared','group'],'kind');if(kind!=='personal')owner(a)
  const box:Box={id:id(),owner_id:a.operator.id,admin_id:a.operator.id,kind,name:text(v.name,'name'),revision:1}
  await commit(env,a,'voicemail.create',box.id,'completed',[nativeFence(db,a),db.prepare('INSERT INTO hnd_mailboxes VALUES (?,?,?,?,?,?)').bind(...Object.values(box))],kind!=='personal')
  return json({box},201)
 }
 const match=path.match(/^\/boxes\/([^/]+)(?:\/(members|owner|observations|items)(?:\/([^/]+)(?:\/(claim|handle|reopen|assign|note))?)?)?$/)
 if(!match)throw new Fault('not_found',404)
 const box=await access(env,a,match[1]).first<Box>();if(!box)throw new Fault('mailbox_refused',403)
 const guards=[nativeFence(db,a),fence(env,a,box.id),db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_mailboxes WHERE id=? AND revision=? AND owner_id=?').bind(box.id,box.revision,box.owner_id)]
 if(request.method==='GET'&&!match[2]){
  const items=(await db.prepare('SELECT * FROM hnd_voicemail_items WHERE box_id=? ORDER BY id').bind(box.id).all<Item>()).results
  const history=(await db.prepare('SELECT h.* FROM hnd_voicemail_history h JOIN hnd_voicemail_items i ON i.id=h.item_id WHERE i.box_id=? ORDER BY h.created_at,h.id').bind(box.id).all()).results
  const caps=await capabilities(env,a,box),readers=await people(env,a,box)
  await commit(env,a,'voicemail.read',box.id,'completed',guards,false)
  return json({actorId:a.operator.id,box,items:items.map(presented),due:items.filter(i=>i.state==='open').map(i=>i.id),history,capabilities:caps,people:readers})
 }
 if(request.method!=='POST'||!v)throw new Fault('method_not_allowed',405)
 if(match[2]==='owner'){
  keys(v,['personId','revision']);owner(a)
  if(box.kind==='personal'||box.admin_id!==a.operator.id)throw new Fault('mailbox_administration_required',403)
  if(integer(v.revision,'revision',1)!==box.revision)throw new Fault('mailbox_revision_conflict',409)
  const person=text(v.personId,'personId')
  // Designation stays within this box's current work membership.
  guards.push(...await targetWorker(env,a,box.id,person),db.prepare('UPDATE hnd_mailboxes SET owner_id=?,revision=revision+1 WHERE id=?').bind(person,box.id))
  await commit(env,a,'voicemail.assign',box.id,'completed',guards)
  return json({boxId:box.id,ownerId:person,revision:box.revision+1})
 }
 if(match[2]==='members'){
  keys(v,['personId','revision','enabled','allowWork','allowAssign']);if(box.kind==='personal')throw new Fault('personal_box_unshared',403)
  owner(a);if(box.admin_id!==a.operator.id)throw new Fault('box_administrator_required',403)
  if(integer(v.revision,'revision',1)!==box.revision)throw new Fault('mailbox_revision_conflict',409)
  const person=text(v.personId,'personId'),enabled=integer(v.enabled,'enabled',0,1)
  guards.push(db.prepare('DELETE FROM hnd_mailbox_members WHERE box_id=? AND person_id=?').bind(box.id,person))
  if(enabled){
   const p=await db.prepare("SELECT version FROM oa_operators WHERE id=? AND status='active'").bind(person).first<{version:number}>();if(!p)throw new Fault('active_person_required',409)
   guards.push(db.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'").bind(person,p.version),db.prepare('INSERT INTO hnd_mailbox_members VALUES (?,?,?,?,?,?,?)').bind(box.id,person,p.version,a.operator.id,a.operator.version,integer(v.allowWork??1,'allowWork',0,1),integer(v.allowAssign??0,'allowAssign',0,1)))
  }
  guards.push(db.prepare('UPDATE hnd_mailboxes SET revision=revision+1 WHERE id=?').bind(box.id))
  await commit(env,a,'voicemail.membership',box.id,'completed',guards)
  return json({revision:box.revision+1,enabled})
 }
 if(match[2]==='observations'){
  keys(v,['sourceId','text','language']);if(box.owner_id!==a.operator.id)throw new Fault('box_owner_required',403)
  guards.push(await requireOperation(env,a,box.id,'work'))
  const source=text(v.sourceId,'sourceId'),observation=text(v.text,'text',10000),language=choice(v.language,['en','es'],'language')
  const old=await db.prepare('SELECT * FROM hnd_voicemail_items WHERE box_id=? AND source_id=?').bind(box.id,source).first<Item>()
  if(old){if(old.observation!==observation||old.language!==language)throw new Fault('observation_replay_conflict',409);guards.push(itemFence(db,old));await commit(env,a,'voicemail.read',old.id,'completed',guards,false);return json({item:presented(old),replay:true})}
  const item:Item={id:id(),box_id:box.id,source_id:source,observation,language,claimant:null,state:'open',revision:1}
  guards.push(db.prepare('INSERT INTO hnd_guard(ok) SELECT NOT EXISTS(SELECT 1 FROM hnd_voicemail_items WHERE box_id=? AND source_id=?)').bind(box.id,source),db.prepare('INSERT INTO hnd_voicemail_items VALUES (?,?,?,?,?,?,?,?)').bind(...Object.values(item)),db.prepare('INSERT INTO hnd_voicemail_history VALUES (?,?,?,?,?,?,?)').bind(id(),item.id,a.operator.id,'observed',1,Date.now(),''))
  await commit(env,a,'voicemail.observe',item.id,'completed',guards,false)
  return json({item:presented(item),replay:false},201)
 }
 if(match[2]!=='items'||!match[3]||!match[4])throw new Fault('not_found',404)
 keys(v,match[4]==='assign'?['revision','personId']:match[4]==='note'?['revision','note']:['revision']);const item=await db.prepare('SELECT * FROM hnd_voicemail_items WHERE id=? AND box_id=?').bind(match[3],box.id).first<Item>();if(!item)throw new Fault('not_found',404)
 if(integer(v.revision,'revision',1)!==item.revision)throw new Fault('voicemail_revision_conflict',409)
 const op=match[4]
 guards.push(await requireOperation(env,a,box.id,op==='assign'?'assign':'work'))
 if(op==='claim'){if(item.state!=='open'||item.claimant)throw new Fault('already_claimed',409)}
 else if(['handle','reopen'].includes(op)&&item.claimant!==a.operator.id&&box.owner_id!==a.operator.id)throw new Fault('claimant_or_box_owner_required',403)
 if(op==='handle'&&item.state!=='open'||op==='reopen'&&item.state!=='handled')throw new Fault('voicemail_state_conflict',409)
 let assigned=item.claimant
 if(op==='assign'){
  if(item.state!=='open')throw new Fault('voicemail_state_conflict',409)
  assigned=text(v.personId,'personId')
  guards.push(...await targetWorker(env,a,box.id,assigned))
 }
 const note=op==='note'?text(v.note,'note',2000):''
 guards.push(itemFence(db,item),db.prepare('UPDATE hnd_voicemail_items SET claimant=?,state=?,revision=revision+1 WHERE id=?').bind(op==='claim'?a.operator.id:op==='reopen'?null:assigned,op==='handle'?'handled':op==='reopen'?'open':item.state,item.id),db.prepare('INSERT INTO hnd_voicemail_history VALUES (?,?,?,?,?,?,?)').bind(id(),item.id,a.operator.id,op,item.revision+1,Date.now(),note))
 await commit(env,a,'voicemail.'+op,item.id,'completed',guards,false)
 return json({item:presented((await db.prepare('SELECT * FROM hnd_voicemail_items WHERE id=?').bind(item.id).first<Item>())!)})
}
