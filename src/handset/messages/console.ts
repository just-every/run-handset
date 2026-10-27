import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, owner, type ObjectValue } from '../core'
import { messagesPage, messageSettingsPage, type Detail, type MessageSnapshot, type Refusal } from './pages'

type Door = (request:Request, env:Bindings, actor:Session, value?:ObjectValue) => Promise<Response|null>
const utc = (value:unknown,name:string) => {
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw new Fault('invalid_'+name)
 const at=Date.parse(value+':00Z'); if(!Number.isFinite(at)) throw new Fault('invalid_'+name)
 return at
}
function formValue(suffix:string,raw:ObjectValue):ObjectValue {
 if(suffix.endsWith('/claim')||suffix.endsWith('/cancel')||suffix.endsWith('/dispatch'))return {revision:Number(raw.revision)}
 if(suffix.endsWith('/handoff'))return {revision:Number(raw.revision),custody:raw.custody}
 if(suffix.endsWith('/approve'))return {revision:Number(raw.revision),confirm:raw.confirm}
 if(suffix.endsWith('/refresh')||suffix.endsWith('/revoke'))return {}
 if(suffix==='/group-routes')return {sourceId:raw.sourceId,serviceSid:raw.serviceSid,conversationSid:raw.conversationSid,confirm:raw.confirm}
 if(suffix==='/snippets')return {name:raw.name,body:raw.body}
 if(suffix==='/permissions')return {recipient:raw.recipient,purpose:'customer-care',evidence:raw.evidence,expiresAt:utc(raw.expiresAt,'expiresAt'),confirm:raw.confirm}
 if(suffix.endsWith('/schedule')) {
  const match=String(raw.snippet??'').match(/^(.+):(\d+)$/);if(!match)throw new Fault('invalid_snippet')
  const hasMedia=Boolean(raw.mediaUrl||raw.mediaMime||raw.mediaBytes)
  return {revision:Number(raw.revision),snippetId:match[1],snippetRevision:Number(match[2]),dueAt:utc(raw.dueAt,'dueAt'),permissionId:raw.permissionId,media:hasMedia?[{url:raw.mediaUrl,mime:raw.mediaMime,bytes:Number(raw.mediaBytes)}]:[]}
 }
 throw new Fault('not_found',404)
}
export async function messageConsole(request:Request,env:Bindings,actor:Session,door:Door,raw?:ObjectValue):Promise<Response|null> {
 const url=new URL(request.url),base='/app/messages'
 if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return null
 owner(actor)
 const suffix=url.pathname.slice(base.length)
 const api=async(path:string,value?:ObjectValue) => {
  const response=await door(new Request(new URL('/api/handset/messages'+path,url),{method:value?'POST':'GET'}),env,actor,value)
  if(!response)throw new Fault('not_found',404)
  if(!response.ok) { const body=await response.json().catch(()=>({})) as {error?:string;code?:string};throw new Fault(body.code??body.error??'request_refused',response.status) }
  return response
 }
 const snapshot=async()=>await (await api('')).json() as MessageSnapshot
 const render=async(data:MessageSnapshot,threadId:string|null,refusal?:Refusal) => {
  if(!threadId)return messagesPage(data,undefined,undefined,refusal)
  const detail=await (await api('/threads/'+encodeURIComponent(threadId))).json() as Detail
  const suppression=await (await api('/thread-suppression?threadId='+encodeURIComponent(detail.thread.id))).json() as {suppressed:boolean}
  return messagesPage(data,detail,suppression.suppressed,refusal)
 }
 if(request.method==='GET') {
  if(suffix==='/settings')return messageSettingsPage(await snapshot())
  if(suffix!=='')throw new Fault('not_found',404)
  return render(await snapshot(),url.searchParams.get('thread'))
 }
 if(request.method!=='POST'||!raw)throw new Fault('method_not_allowed',405)
 const before=await snapshot(),threadMatch=suffix.match(/^\/threads\/([^/]+)\//),jobMatch=suffix.match(/^\/jobs\/([^/]+)\//)
 const threadId=threadMatch?decodeURIComponent(threadMatch[1]):jobMatch?before.jobs.find(j=>j.id===decodeURIComponent(jobMatch[1]))?.thread_id??null:null
 const settings=suffix.startsWith('/group-routes')||suffix==='/snippets'||suffix==='/permissions'||suffix.startsWith('/permissions/')
 try {
  await api(suffix,formValue(suffix,raw))
  return new Response(null,{status:303,headers:{location:settings?base+'/settings':threadId?base+'?thread='+encodeURIComponent(threadId):base,'cache-control':'no-store'}})
 } catch(error) {
  if(!(error instanceof Fault)||error.status>=500||error.status===401||error.status===403&&error.code==='owner_required')throw error
  const refusal={code:error.code,status:error.status,values:raw,action:url.pathname}
  const current=await snapshot()
  return settings?messageSettingsPage(current,refusal):render(current,threadId,refusal)
 }
}
