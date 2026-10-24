import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { allowedNumbers, authorizeNumber } from '../access/numbers'
import { choice, escape as e, Fault, id, input, json, owner, ownerFence, page, session, text, type ObjectValue } from '../core'
import { authorizeCase, caseVisibility, combineAuthority, type CaseAuthority } from './access'
import { authorizeRecordWrite, recordVisibility, scopedRecord, teammateRecordKinds } from './access-records'
import { authorizeCaseAssignment, scopedPeople } from './access-people'
import { readUsage } from './usage'
import { kinds } from './model'
import { casePage, casesPage, recordForm, type PersonOption } from './pages'
import { addRecord, caseFilter, getCase, getRecord, listCases, saveFilter, writeCase } from './store'

const redirect=(path:string)=>new Response(null,{status:303,headers:{location:path,'cache-control':'no-store'}})
function formValues(data:ObjectValue){
 if(typeof data.version==='string')data.version=Number(data.version)
 for(const name of ['handled','unread'])if(typeof data[name]==='string')data[name]=Number(data[name])
 if(typeof data.dueAt==='string')data.dueAt=data.dueAt?Date.parse(data.dueAt+'Z'):null
 return data
}

/** Metadata/work only. Number work never supplies playback or carrier effects. */
export async function recordsDoor(request:Request,env:Bindings,actor:Session):Promise<Response|null>{
 const url=new URL(request.url),path=url.pathname,html=path.startsWith('/app/')
 if(!/^\/(?:app\/(?:cases|records)|api\/handset\/(?:cases|records|filters))(?:\/|$)/.test(path))return null
 const checked=await session(request,env)
 if(checked.session.id!==actor.id)throw new Fault('session_mismatch',403)
 env=checked.env;actor=checked.session
 const db=env.DB,owned=actor.operator.role==='owner',read=request.method==='GET',write=request.method==='POST'
 if(!read&&!write)throw new Fault('method_not_allowed',405)
 const scope=async()=>{
  if(owned)return {fences:[ownerFence(env.DB,actor)],applied:{}}
  const numbers=await allowedNumbers(env,actor)
  if(!numbers.length)throw new Fault('case_access_required',403)
  return combineAuthority(...await Promise.all(numbers.map(number=>authorizeNumber(env,actor,number))))
 }
 await scope()
 const release=async(action:string,subject:string,response:Response,authority:CaseAuthority)=>{
  await commit(env,actor,action,subject,'completed',authority.fences,false,authority.applied);return response
 }
 const people=async(caseId?:string,rows?:Awaited<ReturnType<typeof listCases>>):Promise<PersonOption[]>=>{
  if(caseId)return (await scopedPeople(env,actor,caseId)).people
  if(owned)return (await db.prepare("SELECT id,display_name FROM oa_operators WHERE status='active' ORDER BY display_name,id").all<PersonOption>()).results
  const ids=[actor.operator.id,...(rows??[]).map(row=>row.owner_id)]
  return (await db.prepare("SELECT id,display_name FROM oa_operators WHERE status='active' AND id IN(SELECT value FROM json_each(?)) ORDER BY display_name,id").bind(JSON.stringify(ids)).all<PersonOption>()).results
 }
 const caseResponse=async(detail:Awaited<ReturnType<typeof getCase>>,notice='',status=200)=>{
  const response=html?await casePage(detail,notice,status,await people(detail.current.id)):json(detail,status)
  return release('case.read',detail.current.id,response,await authorizeCase(env,actor,detail.current.id))
 }
 const add=async(value:ObjectValue)=>{
  const authority=await authorizeRecordWrite(env,actor,value)
  try{
   const result=await addRecord(env,actor,value,authority)
   if(!owned){const current=await recordVisibility(env,actor,result.record.id);await commit(env,actor,'record.read',result.record.id,'completed',current.fences,false,current.applied)}
   return result
  }catch(error){
   if(!owned&&error instanceof Fault&&error.code==='source_conflict')throw new Fault('source_conflict',409)
   throw error
  }
 }
 if(read&&['/app/cases','/api/handset/cases'].includes(path)){
  const query=caseFilter(Object.fromEntries(url.searchParams)),visible=await caseVisibility(env,actor)
  const rows=await listCases(db,query,visible??undefined)
  const filters=(await db.prepare('SELECT name,query FROM hnd_filters WHERE operator_id=? ORDER BY name').bind(actor.operator.id).all<{name:string;query:string}>()).results
  const response=html?await casesPage(rows,actor.operator.id,filters,query,await people(undefined,rows),owned):json({cases:rows,limited:rows.length>200})
  const authorities=await Promise.all(rows.map(row=>authorizeCase(env,actor,row.id)))
  return release('case.list','installation',response,combineAuthority(await scope(),...authorities))
 }
 if(write&&['/api/handset/cases','/app/cases/new'].includes(path)){
  owner(actor);const value=await input(request),detail=await writeCase(env,actor,html?formValues(value):value)
  return html?redirect('/app/cases/'+detail.current.id):json(detail,201)
 }
 const nativeRecord=path.match(/^\/app\/cases\/([^/]+)\/record$/)
 if(nativeRecord){
  const caseId=nativeRecord[1];await authorizeCase(env,actor,caseId)
  if(read){
   const detail=await getCase(db,caseId),kind=choice(url.searchParams.get('kind')??'comment',kinds,'kind')
   if(!owned&&!(teammateRecordKinds as readonly string[]).includes(kind))throw new Fault('record_access_required',403)
   const response=await recordForm(caseId,detail.records,kind,owned?kinds:teammateRecordKinds)
   return release('case.read',caseId,response,await authorizeCase(env,actor,caseId))
  }
  const value=await input(request),data:ObjectValue={}
  for(const [key,v] of Object.entries(value))if(key.startsWith('data.')){
   if(v!==''){const name=key.slice(5);data[name]=name==='dueAt'?Date.parse(String(v)+'Z'):['amountCents','sizeBytes'].includes(name)?Number(v):v}
   delete value[key]
  }
  await add({...value,caseId,occurredAt:Date.parse(String(value.occurredAt)+'Z'),data,links:data.mention?[{targetId:data.mention,relation:'mentions'}]:[]})
  return redirect('/app/cases/'+caseId)
 }
 const match=path.match(/^\/(?:app|api\/handset)\/cases\/([^/]+)(?:\/(edit|comment))?$/)
 if(match&&match[1]!=='filter'){
  const caseId=text(match[1],'caseId');await authorizeCase(env,actor,caseId)
  if(read&&!match[2])return caseResponse(await getCase(db,caseId))
  if(write&&match[2]!=='comment'){
   const raw=await input(request),value=html?formValues(raw):raw
   const authority=await authorizeCaseAssignment(env,actor,caseId,text(value.ownerId??actor.operator.id,'ownerId'))
   try{
    const detail=await writeCase(env,actor,value,caseId,authority)
    if(html)return redirect('/app/cases/'+caseId)
    return caseResponse(detail)
   }catch(error){
    if(error instanceof Fault&&error.code==='version_conflict'){
     const detail=await getCase(db,caseId)
     if(html)return caseResponse(detail,'Another teammate changed this case. Review the current version below and reapply your edit.',409)
     await release('case.read',caseId,json({}),await authorizeCase(env,actor,caseId))
     throw new Fault('version_conflict',409,detail)
    }
    throw error
   }
  }
  if(write&&match[2]==='comment'){
   const value=await input(request),mention=value.mention?text(value.mention,'mention'):null
   const result=await add({kind:'comment',sourceId:id(),occurredAt:Date.now(),caseId,data:{text:text(value.text,'text',4000),...(mention?{mention}:{})},links:mention?[{targetId:mention,relation:'mentions'}]:[]})
   return html?redirect('/app/cases/'+caseId):json(result,201)
  }
 }
 if(write&&['/app/cases/filter','/api/handset/filters'].includes(path)){
  const value=await input(request)
  if(html&&typeof value.query==='string'){try{value.query=JSON.parse(value.query)}catch{throw new Fault('invalid_query')}}
  const result=await saveFilter(env,actor,value,owned?undefined:await scope())
  return html?redirect('/app/cases'):json(result,201)
 }
 if(write&&path==='/api/handset/records')return json(await add(await input(request)),201)
 const usage=path.match(/^\/(?:app|api\/handset)\/records\/([^/]+)\/usage-receipt$/)
 if(write&&usage){
  owner(actor);const result=await readUsage(env,actor,usage[1],await input(request))
  return html?redirect('/app/records/'+result.record!.id):json(result,result.replay?200:201)
 }
 const record=path.match(/^\/(?:app|api\/handset)\/records\/([^/]+)$/)
 if(read&&record){
  await recordVisibility(env,actor,record[1]);const result=await scopedRecord(env,actor,await getRecord(db,record[1]))
  const response=html?await recordPage(result.detail,owned):json(result.detail)
  // Recompute the released references and their exact capability snapshots.
  const current=await scopedRecord(env,actor,result.detail)
  return release('record.read',record[1],response,combineAuthority(result,current))
 }
 throw new Fault('not_found',404)
}

async function recordPage(result:Awaited<ReturnType<typeof getRecord>>,owned:boolean){
 const r=result.record
 const usage=owned&&r.source==='twilio'&&['call_session','call_leg','message','recording'].includes(r.kind)?`<form method="post" action="/app/records/${e(r.id)}/usage-receipt"><input type="hidden" name="confirm" value="read exact billed usage"><button>Read carrier price / Consultar costo</button></form><p>A carrier price is not a reconciled invoice / El costo del proveedor no es una factura conciliada.</p>`:''
 const playback=r.kind==='recording'&&r.source==='twilio'?`<p><a href="/app/recordings/${e(r.id)}">Open recording / Abrir grabación</a></p><p>Separate exact-person playback approval is required / Se requiere permiso individual para escuchar.</p>`:''
 return page('Source record',`${usage}${playback}<dl>${Object.entries(r).map(([key,value])=>`<dt>${e(key)}</dt><dd>${e(value)}</dd>`).join('')}</dl><h2>Related source events</h2><ul>${result.related.map(child=>`<li><a href="/app/records/${e(child.id)}">${e(child.kind)} · ${e(child.source_id)}</a></li>`).join('')}</ul><h2>Linked sources</h2><ul>${result.links.map(l=>`<li>${e(l.relation)} <a href="/app/records/${e(l.target_id)}">${e(l.target_id)}</a></li>`).join('')}</ul>${r.parent_id?`<a href="/app/records/${e(r.parent_id)}">Parent source</a>`:''}${r.case_id?`<p><a href="/app/cases/${e(r.case_id)}">Return to case</a></p>`:''}`)
}
