import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { choice, Fault, id, integer, json, keys, object, owner, text, type ObjectValue } from '../core'

interface Phone { label:string; number:string; extension:string }
interface Contact { name:string; timezone:string; tags:string[]; consentReferences:string[]; phones:Phone[]; stopped:boolean; held:boolean; sourceIds:{source:string; id:string}[] }
interface Row { id:string; revision:number; scope:'personal'|'company'; owner_id:string; value:string; merged_into:string|null }
// National numbers require an explicit calling code. Missing timezone stays unknown.
export function phone(raw:unknown):Phone {
 const v=object(raw);keys(v,['label','number','extension','callingCode'])
 let number=text(v.number,'number',80),extension=text(v.extension??'','extension',12,true)
 const suffix=number.match(/\s*(?:ext\.?|x|;ext=)\s*(\d+)$/i)
 if(suffix){if(extension&&extension!==suffix[1])throw new Fault('conflicting_extension');extension=suffix[1];number=number.slice(0,suffix.index)}
 if(extension&&!/^\d{1,12}$/.test(extension))throw new Fault('invalid_extension')
 if(!/^\+?[\d\s().-]+$/.test(number))throw new Fault('invalid_number')
 number=number.replace(/[\s().-]/g,'')
 if(!number.startsWith('+')){
  const code=text(v.callingCode,'callingCode',3)
  if(!/^[1-9]\d{0,2}$/.test(code))throw new Fault('invalid_calling_code')
  number='+'+code+number
 }
 if(!/^\+[1-9]\d{1,14}$/.test(number))throw new Fault('invalid_e164')
 return {label:text(v.label??'work','label',40),number,extension}
}
const strings=(v:unknown,name:string)=>{
 if(!Array.isArray(v)||v.length>50)throw new Fault('invalid_'+name)
 return [...new Set(v.map(s=>text(s,name,200)))].sort()
}
function parse(value:unknown):Contact {
 const v=object(value);keys(v,['name','timezone','tags','consentReferences','phones','stopped','held','sourceIds'])
 if(!Array.isArray(v.phones)||!v.phones.length||v.phones.length>20)throw new Fault('invalid_phones')
 const timezone=text(v.timezone??'','timezone',80,true)
 if(timezone){try{new Intl.DateTimeFormat('en',{timeZone:timezone})}catch{throw new Fault('invalid_timezone')}}
 for(const k of ['stopped','held'])if(v[k]!==undefined&&typeof v[k]!=='boolean')throw new Fault('invalid_'+k)
 if(!Array.isArray(v.sourceIds??[])||((v.sourceIds??[]) as unknown[]).length>50)throw new Fault('invalid_source_ids')
 const sourceIds=((v.sourceIds??[]) as unknown[]).map(raw=>{const s=object(raw);keys(s,['source','id']);return {source:text(s.source,'source',80),id:text(s.id,'source_id',200)}})
 const phones=[...new Map(v.phones.map(p=>{const n=phone(p);return [JSON.stringify(n),n]})).values()]
 return {name:text(v.name,'name'),timezone,tags:strings(v.tags??[],'tags'),consentReferences:strings(v.consentReferences??[],'consent_references'),phones,stopped:v.stopped===true,held:v.held===true,sourceIds}
}
const native=(r:Row)=>({id:r.id,revision:r.revision,scope:r.scope,ownerId:r.owner_id,...JSON.parse(r.value) as Contact})
async function row(env:Bindings,contactId:string){const r=await env.DB.prepare('SELECT * FROM hnd_contacts WHERE id=? AND merged_into IS NULL').bind(contactId).first<Row>();if(!r)throw new Fault('contact_not_found',404);return r}
function revision(r:Row,v:unknown){if(integer(v,'revision',1)!==r.revision)throw new Fault('version_conflict',409)}
const check=(env:Bindings,r:Row)=>env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_contacts WHERE id=? AND revision=? AND merged_into IS NULL').bind(r.id,r.revision)
const current=(actor:Session)=>({sql:`EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id WHERE s.id=? AND s.operator_id=? AND s.operator_version=o.version AND o.status='active' AND s.revoked_at IS NULL AND s.expires_at>?)`,args:[actor.id,actor.operator.id,Date.now()]})
function visible(actor:Session){return actor.operator.role==='owner'?`(scope='company' OR owner_id=?)`:`(owner_id=? OR EXISTS(SELECT 1 FROM hnd_contact_grants g WHERE g.contact_id=hnd_contacts.id AND g.operator_id=? AND g.active=1))`}
async function read(env:Bindings,actor:Session,contactId?:string){
 const c=current(actor),args=actor.operator.role==='owner'?[actor.operator.id]:[actor.operator.id,actor.operator.id]
 return (await env.DB.prepare(`SELECT * FROM hnd_contacts WHERE merged_into IS NULL AND ${visible(actor)} AND ${c.sql}${contactId?' AND id=?':''} ORDER BY id`).bind(...args,...c.args,...(contactId?[contactId]:[])).all<Row>()).results
}
export async function directoryDoor(request:Request,env:Bindings,actor:Session,data?:ObjectValue):Promise<Response>{
 const url=new URL(request.url),tail=url.pathname.slice('/api/handset/directory'.length),db=env.DB
 if(request.method==='GET'){
  if(tail===''||tail==='/export'){
   if(tail==='/export')owner(actor)
   return json({contacts:(await read(env,actor)).map(native),callerAuthentication:false,messageConsentGranted:false})
  }
  if(tail==='/match'){
   const number=phone({number:url.searchParams.get('number'),callingCode:url.searchParams.get('callingCode')??undefined}).number
   const matches=(await read(env,actor)).filter(r=>(JSON.parse(r.value) as Contact).phones.some(p=>p.number===number))
   // An ambiguous number returns no names, IDs or customer records.
   return json({state:matches.length>1?'ambiguous':matches.length===1?'context':'unknown',callerAuthenticated:false,...(matches.length===1?{contact:native(matches[0])}:{})})
  }
  const match=tail.match(/^\/([^/]+)$/)
  if(match){const rows=await read(env,actor,match[1]);if(!rows.length)throw new Fault('contact_not_found',404);return json({contact:native(rows[0])})}
  throw new Fault('not_found',404)
 }
 if(request.method!=='POST')throw new Fault('method_not_allowed',405)
 owner(actor);const v=data??{}
 if(tail===''){
  keys(v,['scope','contact']);const scope=choice(v.scope??'company',['personal','company'] as const,'scope'),contact=parse(v.contact),contactId=id()
  await commit(env,actor,'directory.create',contactId,'completed',[db.prepare('INSERT INTO hnd_contacts(id,revision,scope,owner_id,value) VALUES(?,1,?,?,?)').bind(contactId,scope,actor.operator.id,JSON.stringify(contact))])
  return json({contact:native(await row(env,contactId))},201)
 }
 const match=tail.match(/^\/([^/]+)\/(update|merge|grant|revoke)$/)
 if(!match)throw new Fault('not_found',404)
 const r=await row(env,match[1]);if(!(await read(env,actor,r.id)).length)throw new Fault('contact_not_found',404)
 revision(r,v.revision)
 const old=JSON.parse(r.value) as Contact
 if(match[2]==='grant'||match[2]==='revoke'){
  keys(v,['revision','operatorId']);if(r.scope==='personal')throw new Fault('personal_contact_cannot_be_shared',403)
  const operatorId=text(v.operatorId,'operatorId'),active=match[2]==='grant'?1:0
  if(active&&!await db.prepare("SELECT id FROM oa_operators WHERE id=? AND status='active'").bind(operatorId).first())throw new Fault('active_member_required',409)
  await commit(env,actor,'directory.'+match[2],r.id,'completed',[check(env,r),db.prepare('INSERT INTO hnd_contact_grants VALUES(?,?,?) ON CONFLICT(contact_id,operator_id) DO UPDATE SET active=excluded.active').bind(r.id,operatorId,active),db.prepare('UPDATE hnd_contacts SET revision=revision+1 WHERE id=?').bind(r.id)])
 }else if(match[2]==='update'){
  keys(v,['revision','contact']);const next=parse(v.contact)
  // Contact edits cannot clear suppression or holds, nor lose source identities.
  next.stopped ||= old.stopped;next.held ||= old.held
  next.sourceIds=[...new Map([...old.sourceIds,...next.sourceIds].map(s=>[JSON.stringify(s),s])).values()]
  await commit(env,actor,'directory.update',r.id,'completed',[check(env,r),db.prepare('UPDATE hnd_contacts SET revision=revision+1,value=? WHERE id=?').bind(JSON.stringify(next),r.id)])
 }else{
  keys(v,['revision','otherId','otherRevision','confirm'])
  if(v.confirm!=='merge these exact contacts')throw new Fault('explicit_merge_required')
  const other=await row(env,text(v.otherId,'otherId'));if(other.id===r.id)throw new Fault('distinct_contacts_required')
  if(!(await read(env,actor,other.id)).length)throw new Fault('contact_not_found',404)
  revision(other,v.otherRevision)
  // Never widen a personal contact or silently propagate access grants.
  if(other.scope!==r.scope||other.owner_id!==r.owner_id)throw new Fault('merge_scope_conflict',409)
  const second=JSON.parse(other.value) as Contact
  const next:Contact={...old,stopped:old.stopped||second.stopped,held:old.held||second.held,timezone:old.timezone||second.timezone,
   phones:[...new Map([...old.phones,...second.phones].map(p=>[JSON.stringify(p),p])).values()],tags:[...new Set([...old.tags,...second.tags])].sort(),consentReferences:[...new Set([...old.consentReferences,...second.consentReferences])].sort(),sourceIds:[...new Map([...old.sourceIds,...second.sourceIds].map(s=>[JSON.stringify(s),s])).values()]}
  await commit(env,actor,'directory.merge',r.id,'completed',[check(env,r),check(env,other),db.prepare('UPDATE hnd_contacts SET revision=revision+1,value=? WHERE id=?').bind(JSON.stringify(next),r.id),db.prepare('UPDATE hnd_contacts SET revision=revision+1,merged_into=? WHERE id=?').bind(r.id,other.id),db.prepare('DELETE FROM hnd_contact_grants WHERE contact_id IN (?,?)').bind(r.id,other.id)])
 }
 return json({contact:native(await row(env,r.id))})
}
