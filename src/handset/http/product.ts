import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { session, owner, json, input, Fault, page, text, id } from '../core'
import { auditDoor } from '../audit/doors'
import { commit, denied } from '../audit/store'
import { getCase, writeCase, addRecord, getRecord, listCases, caseFilter, saveFilter } from '../records/store'
import { casesPage, casePage } from '../records/pages'

function formValues(data: Record<string,unknown>) {
 if (typeof data.version === 'string') data.version = Number(data.version)
 for (const name of ['handled','unread']) if (typeof data[name] === 'string') data[name] = Number(data[name])
 if (typeof data.dueAt === 'string') data.dueAt = data.dueAt ? new Date(data.dueAt+'Z').getTime() : null
 return data
}
export async function productResponse(request: Request, original: Bindings): Promise<Response|null> {
 const url = new URL(request.url), path = url.pathname, html = path.startsWith('/app/')
 if (!/^\/(api\/handset|app\/(cases|records|audit|grants))(\/|$)/.test(path)) return null
 let auth: {env:Bindings;session:Session}|undefined
 try {
  auth = await session(request,original)
  const {env,session:actor} = auth, db=env.DB
  try { owner(actor) } catch(error) { await denied(env,actor,'product.access'); throw error }
  const read = request.method === 'GET', write = request.method === 'POST'
  if (path.startsWith('/api/handset/audit') || path.startsWith('/app/audit')) {
   const response = await auditDoor(request,env,actor,read ? undefined : await input(request,2097152))
   if(response)return response
  }
  if (!read && !write) throw new Fault('method_not_allowed',405)
  if (read && (path === '/app/cases' || path === '/api/handset/cases')) {
   const query=caseFilter(Object.fromEntries(url.searchParams)), rows=await listCases(db,query)
   await commit(env,actor,'case.list','installation','completed')
   if (!html) return json({cases:rows,limited:rows.length>200})
   const filters=(await db.prepare('SELECT name,query FROM hnd_filters WHERE operator_id=? ORDER BY name').bind(actor.operator.id).all<{name:string;query:string}>()).results
   return casesPage(rows,actor.operator.id,filters,query)
  }
  if (write && ['/api/handset/cases','/app/cases/new'].includes(path)) {
   const data=await input(request), detail=await writeCase(env,actor,html?formValues(data):data)
   return html ? redirect('/app/cases/'+detail.current.id) : json(detail,201)
  }
  const match=path.match(/^\/(?:app|api\/handset)\/cases\/([^/]+)(?:\/(edit|comment))?$/)
  if (match && match[1] !== 'filter') {
   const caseId=text(match[1],'caseId')
   if (read && !match[2]) { const detail=await getCase(db,caseId);await commit(env,actor,'case.read',caseId,'completed');return html?casePage(detail):json(detail) }
   if (write && match[2] !== 'comment') {
    const data=await input(request)
    try { const detail=await writeCase(env,actor,html?formValues(data):data,caseId);return html?redirect('/app/cases/'+caseId):json(detail) }
    catch(error) { if(html && error instanceof Fault && error.code==='version_conflict')return casePage(await getCase(db,caseId),'Another teammate changed this case. Review the current version below and reapply your edit.',409);throw error }
   }
   if(write && match[2] === 'comment') {
    const data=await input(request), mention=data.mention ? text(data.mention,'mention'):null
    const result=await addRecord(env,actor,{kind:'comment',sourceId:id(),occurredAt:Date.now(),caseId,data:{text:text(data.text,'text',4000),...(mention?{mention}:{})},links:mention?[{targetId:mention,relation:'mentions'}]:[]})
    return html?redirect('/app/cases/'+caseId):json(result,201)
   }
  }
  if(write && ['/app/cases/filter','/api/handset/filters'].includes(path)) {
   const data=await input(request)
   if(html && typeof data.query==='string') {try{data.query=JSON.parse(data.query)}catch{throw new Fault('invalid_query')}}
   const result=await saveFilter(env,actor,data);return html?redirect('/app/cases'):json(result,201)
  }
  if(write && path==='/api/handset/records')return json(await addRecord(env,actor,await input(request)),201)
  const record=path.match(/^\/(?:app|api\/handset)\/records\/([^/]+)$/)
  if(read && record){const result=await getRecord(db,record[1]);await commit(env,actor,'record.read',record[1],'completed');return html?recordPage(result):json(result)}
  throw new Fault('not_found',404)
 } catch(error) {
  if(error instanceof Fault){
   if(auth && error.status<500 && error.code!=='owner_required')await denied(auth.env,auth.session,'product.request')
   return html?page(error.code,`<p role="alert">${error.code.replaceAll('_',' ')}</p><a href="/app/cases">Return to cases</a>`,error.status):json({error:error.code,...(error.detail?{detail:error.detail}:{})},error.status)
  }
  console.error('Handset product request failed',error instanceof Error?error.name:'unknown')
  return html?page('Temporarily unavailable','<p role="alert">No completion is claimed. Retry or reload the current record.</p>',503):json({error:'store_unavailable'},503)
 }
}
function redirect(path:string){return new Response(null,{status:303,headers:{location:path,'cache-control':'no-store'}})}
async function recordPage(result:Awaited<ReturnType<typeof getRecord>>){
 const {escape:e}=await import('../core')
 const r=result.record
 return page('Source record',`<dl>${Object.entries(r).map(([key,value])=>`<dt>${e(key)}</dt><dd>${e(value)}</dd>`).join('')}</dl><h2>Linked sources</h2><ul>${result.links.map(l=>`<li>${e(l.relation)} <a href="/app/records/${e(l.target_id)}">${e(l.target_id)}</a></li>`).join('')}</ul>${r.parent_id?`<a href="/app/records/${e(r.parent_id)}">Parent source</a>`:''}${r.case_id?`<p><a href="/app/cases/${e(r.case_id)}">Return to case</a></p>`:''}`)
}
