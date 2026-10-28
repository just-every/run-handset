import { isValidPhoneNumber } from 'libphonenumber-js'
import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { choice, Fault, id, integer, json, keys, owner, text, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import { nativeFence } from '../preparation/access'
export interface Contact {id:string;owner_id:string;visibility:string;name:string;number:string;extension:string;timezone:string|null;suppressed:number;held:number;sources:string;revision:number;merged_into:string|null}
const root='/api/handset/directory'
const visible=`SELECT c.* FROM hnd_contacts c WHERE c.merged_into IS NULL AND ((c.visibility='personal' AND c.owner_id=?) OR (c.visibility='company' AND (?='owner' OR EXISTS(SELECT 1 FROM hnd_contact_grants g JOIN oa_operators p ON p.id=g.person_id JOIN oa_operators i ON i.id=g.issuer_id WHERE g.contact_id=c.id AND g.person_id=? AND g.person_version=p.version AND p.status='active' AND g.issuer_version=i.version AND i.role='owner' AND i.status='active' AND g.revision=c.revision))))`
const visibleQuery=(env:Bindings,a:Session,suffix='',values:(string|number)[]=[])=>env.DB.prepare(visible+suffix).bind(a.operator.id,a.operator.role,a.operator.id,...values)
async function get(env:Bindings,a:Session,key:string){const c=await visibleQuery(env,a,' AND c.id=?',[key]).first<Contact>();if(!c)throw new Fault('contact_refused',403);return c}
const current=(env:Bindings,c:Contact)=>env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_contacts WHERE id=? AND revision=? AND merged_into IS NULL').bind(c.id,c.revision)
type Capability='edit'|'export'|'merge'
export type ContactCapabilities = Record<Capability, boolean>
const capabilitySql=(cap:Capability)=>visible.replace('g.contact_id=c.id AND',`g.can_${cap}=1 AND g.contact_id=c.id AND`)
const capabilityQuery=(env:Bindings,a:Session,c:Contact,cap:Capability)=>env.DB.prepare(capabilitySql(cap)+' AND c.id=?').bind(a.operator.id,a.operator.role,a.operator.id,c.id)
const capabilityFence=(env:Bindings,a:Session,c:Contact,cap:Capability)=>env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM ('+capabilitySql(cap)+' AND c.id=?)').bind(a.operator.id,a.operator.role,a.operator.id,c.id)
async function requireCapability(env:Bindings,a:Session,c:Contact,cap:Capability){if(!await capabilityQuery(env,a,c,cap).first())throw new Fault('directory_capability_required',403)}
async function output(env:Bindings,a:Session,c:Contact){
 const capabilities:ContactCapabilities={edit:false,export:false,merge:false}
 for(const cap of ['edit','export','merge'] as const)capabilities[cap]=Boolean(await capabilityQuery(env,a,c,cap).first())
 return {...c,sources:JSON.parse(c.sources),capabilities,callerAuthenticated:false,messagingConsent:false,employeeAccess:false}
}
function number(raw:unknown){
 const value=text(raw,'number',60),parts=value.match(/^(.*?)(?:\s*(?:ext\.?|x|#)\s*(\d{1,8}))?$/i)!,normalized=parts[1].replace(/[\s().-]/g,'')
 if(!/^\+[1-9]\d{7,14}$/.test(normalized))throw new Fault('explicit_calling_code_required')
 if(!isValidPhoneNumber(normalized))throw new Fault('invalid_regional_number')
 return {number:normalized,extension:parts[2]??''}
}
function sources(raw:unknown){if(!Array.isArray(raw)||raw.length>20)throw new Fault('invalid_sources');return [...new Set(raw.map(x=>text(x,'source',120)))].sort()}
export async function directoryDoor(request:Request,env:Bindings,a:Session,v?:ObjectValue):Promise<Response>{
 const url=new URL(request.url),path=url.pathname.slice(root.length),db=env.DB
 if(request.method==='GET'&&path==='/grants'){
  owner(a)
  const grants=(await db.prepare('SELECT contact_id,person_id,person_version,issuer_id,issuer_version,revision,can_edit,can_export,can_merge FROM hnd_contact_grants ORDER BY contact_id,person_id').all()).results
  await commit(env,a,'directory.read','installation','completed')
  return json({grants})
 }
 if(request.method==='GET'){
  let cs=(await visibleQuery(env,a).all<Contact>()).results
  if(path==='/match'){
   const n=number(url.searchParams.get('number'));cs=cs.filter(c=>c.number===n.number&&c.extension===n.extension)
   await commit(env,a,'directory.read','installation','completed',[nativeFence(db,a),...cs.map(c=>visibleQueryFence(env,a,c.id))],false)
   return json({state:cs.length===1?'unique':cs.length?'ambiguous':'unknown',callerAuthenticated:false,...(cs.length===1?{contact:await output(env,a,cs[0])}:{})})
  }
  const key=path.match(/^\/contacts\/([^/]+)$/)?.[1]
  if(key)cs=[await get(env,a,key)]
  else if(path!==''&&path!=='/contacts'&&path!=='/export')throw new Fault('not_found',404)
  if(path==='/export'){
   const exportable:Contact[]=[]
   for(const c of cs)if(await capabilityQuery(env,a,c,'export').first())exportable.push(c)
   cs=exportable
  }
  await commit(env,a,'directory.read','installation','completed',[nativeFence(db,a),...cs.map(c=>path==='/export'?capabilityFence(env,a,c,'export'):visibleQueryFence(env,a,c.id))],false)
  return json(key?{contact:await output(env,a,cs[0])}:{contacts:await Promise.all(cs.map(c=>output(env,a,c)))})
 }
 if(request.method!=='POST'||!v)throw new Fault('method_not_allowed',405)
 if(path==='/contacts'){
  keys(v,['name','number','timezone','visibility','suppressed','held','sources'])
  const visibility=choice(v.visibility??'personal',['personal','company'],'visibility');if(visibility==='company')owner(a)
  const n=number(v.number),zone=v.timezone===undefined||v.timezone===null||v.timezone===''?null:text(v.timezone,'timezone',80)
  if(zone)try{new Intl.DateTimeFormat('en',{timeZone:zone})}catch{throw new Fault('invalid_timezone')}
  const c:Contact={id:id(),owner_id:a.operator.id,visibility,name:text(v.name,'name'),...n,timezone:zone,suppressed:integer(v.suppressed??0,'suppressed',0,1),held:integer(v.held??0,'held',0,1),sources:JSON.stringify(sources(v.sources??[])),revision:1,merged_into:null}
  await commit(env,a,'directory.create',c.id,'completed',[nativeFence(db,a),db.prepare('INSERT INTO hnd_contacts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(...Object.values(c))],visibility==='company')
  return json({contact:await output(env,a,c)},201)
 }
 const edit=path.match(/^\/contacts\/([^/]+)$/)
 if(edit){
  keys(v,['revision','name','number','timezone'])
  const c=await get(env,a,edit[1]);await requireCapability(env,a,c,'edit')
  if(c.visibility==='personal'&&c.owner_id!==a.operator.id)throw new Fault('contact_refused',403)
  if(integer(v.revision,'revision',1)!==c.revision)throw new Fault('contact_revision_conflict',409)
  const n=v.number===undefined?{number:c.number,extension:c.extension}:number(v.number)
  const name=v.name===undefined?c.name:text(v.name,'name')
  const zone=v.timezone===undefined?c.timezone:v.timezone===null||v.timezone===''?null:text(v.timezone,'timezone',80)
  if(zone)try{new Intl.DateTimeFormat('en',{timeZone:zone})}catch{throw new Fault('invalid_timezone')}
  await commit(env,a,'directory.edit',c.id,'completed',[nativeFence(db,a),capabilityFence(env,a,c,'edit'),current(env,c),db.prepare('DELETE FROM hnd_contact_grants WHERE contact_id=?').bind(c.id),db.prepare('UPDATE hnd_contacts SET name=?,number=?,extension=?,timezone=?,revision=revision+1 WHERE id=?').bind(name,n.number,n.extension,zone,c.id)],false)
  return json(c.visibility==='personal'||a.operator.role==='owner'?{contact:await output(env,a,await get(env,a,c.id))}:{contactId:c.id,revision:c.revision+1,grantsWithdrawn:true})
 }
 const m=path.match(/^\/contacts\/([^/]+)\/(grant|revoke|merge)$/);if(!m)throw new Fault('not_found',404)
 const c=await get(env,a,m[1]);if(m[2]!=='merge')owner(a)
 if(c.visibility!=='company')throw new Fault('personal_contact_unshared',403)
 if(integer(v.revision,'revision',1)!==c.revision)throw new Fault('contact_revision_conflict',409)
 if(m[2]==='merge'){
  keys(v,['revision','otherId','otherRevision','confirm']);if(v.confirm!=='merge these exact contacts and withdraw read grants')throw new Fault('merge_confirmation_required',403)
  const other=await get(env,a,text(v.otherId,'otherId'));if(other.id===c.id||other.visibility!=='company')throw new Fault('invalid_merge')
  if(integer(v.otherRevision,'otherRevision',1)!==other.revision)throw new Fault('contact_revision_conflict',409)
  await requireCapability(env,a,c,'merge');await requireCapability(env,a,other,'merge')
  await commit(env,a,'directory.merge',c.id,'completed',[nativeFence(db,a),capabilityFence(env,a,c,'merge'),capabilityFence(env,a,other,'merge'),current(env,c),current(env,other),
   db.prepare('DELETE FROM hnd_contact_grants WHERE contact_id IN (?,?)').bind(c.id,other.id),
   db.prepare('UPDATE hnd_contacts SET suppressed=?,held=?,sources=?,revision=revision+1 WHERE id=?').bind(Math.max(c.suppressed,other.suppressed),Math.max(c.held,other.held),JSON.stringify([...new Set([...JSON.parse(c.sources),...JSON.parse(other.sources)])].sort()),c.id),
   db.prepare('UPDATE hnd_contacts SET merged_into=?,revision=revision+1 WHERE id=?').bind(c.id,other.id)],false)
  return json(a.operator.role==='owner'?{contact:await output(env,a,await get(env,a,c.id)),grantsWithdrawn:true}:{contactId:c.id,revision:c.revision+1,grantsWithdrawn:true})
 }
 keys(v,m[2]==='grant'?['revision','personId','allowEdit','allowExport','allowMerge']:['revision','personId']);const person=text(v.personId,'personId')
 const statements=[current(env,c),db.prepare('DELETE FROM hnd_contact_grants WHERE contact_id=? AND person_id=?').bind(c.id,person)]
 if(m[2]==='grant'){
  const p=await db.prepare("SELECT version FROM oa_operators WHERE id=? AND status='active'").bind(person).first<{version:number}>();if(!p)throw new Fault('active_person_required',409)
  statements.push(db.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'").bind(person,p.version),db.prepare('INSERT INTO hnd_contact_grants VALUES (?,?,?,?,?,?,?,?,?)').bind(c.id,person,p.version,a.operator.id,a.operator.version,c.revision,integer(v.allowEdit??0,'allowEdit',0,1),integer(v.allowExport??0,'allowExport',0,1),integer(v.allowMerge??0,'allowMerge',0,1)))
 }
 await commit(env,a,'directory.'+m[2],c.id,'completed',statements)
 return json({contactId:c.id,personId:person,state:m[2]==='grant'?'granted':'revoked'})
}
function visibleQueryFence(env:Bindings,a:Session,key:string){return env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM ('+visible+' AND c.id=?)').bind(a.operator.id,a.operator.role,a.operator.id,key)}
