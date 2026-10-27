import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, consolePage, escape as e, text, type ObjectValue } from '../core'
import { authorizeFlow, flowReferences } from '../access/flows'
import { sql } from '../delegation/store'
import { flowDoor } from './doors'
import { definition, type FlowDefinition } from './definition'
import { flowsPage, type FlowSnapshot } from './pages'

function parseJSON(value:unknown){try{return JSON.parse(text(value,'json',20000)) as unknown}catch{throw new Fault('invalid_json')}}
const list=(value:unknown)=>String(value??'').split(',').map(v=>v.trim()).filter(Boolean)
function fromForm(v:ObjectValue):FlowDefinition {
 const count=Number(v.nodeCount),overrideCount=Number(v.overrideCount)
 if(!Number.isSafeInteger(count)||count<1||count>50||!Number.isSafeInteger(overrideCount)||overrideCount<1||overrideCount>101)throw new Fault('invalid_form_nodes')
 const minute=(raw:unknown,end=false)=>{const m=String(raw).match(/^(\d\d):(\d\d)$/);if(!m||(Number(m[1])>23&&!(end&&m[1]==='24'&&m[2]==='00'))||Number(m[2])>59)throw new Fault('invalid_hours');return Number(m[1])*60+Number(m[2])}
 return {name:text(v.name,'name'),entry:text(v.entry,'entry'),timezone:text(v.timezone,'timezone'),nodes:Array.from({length:count},(_,i)=>{
  const kind=text(v['kind'+i],'kind'),group=v['strategy'+i]?{strategy:v['strategy'+i],members:Object.entries(v).filter(([key])=>key.startsWith(`member${i}-`)).map(([,value])=>text(value,'memberId'))}:undefined
  const windowCount=Number(v['windowCount'+i]??0);if(!Number.isSafeInteger(windowCount)||windowCount<0||windowCount>100)throw new Fault('invalid_weekly_hours')
  const extras=Array.from({length:windowCount},(_,w)=>({days:list(v[`windowDays${i}-${w}`]).map(Number),startMinute:minute(v[`windowOpens${i}-${w}`]??'09:00'),endMinute:minute(v[`windowCloses${i}-${w}`]??'17:00',true)})).filter(window=>window.days.length)
  return {id:text(v['id'+i],'nodeId'),kind,next:list(v['next'+i]),...(kind==='queue'?{queueId:String(v['queueId'+i]??'')}:{}),...(v['language'+i]?{language:String(v['language'+i])}:{}),...(kind==='hours'?{hours:{weekly:[...(list(v['days'+i]).length?[{days:list(v['days'+i]).map(Number),startMinute:minute(v['opens'+i]),endMinute:minute(v['closes'+i],true)}]:[]),...extras]}}:{}),...(group?{group}: {})}
 }) as FlowDefinition['nodes'],overrides:Array.from({length:overrideCount},(_,i)=>({date:String(v['date'+i]??''),entry:String(v['override'+i]??'')})).filter(o=>o.date||o.entry)}
}
export async function flowConsole(request:Request,env:Bindings,actor:Session,v?:ObjectValue){
 const url=new URL(request.url),suffix=url.pathname.slice('/app/flows'.length)
 if(url.search)throw new Fault('unexpected_flow_query')
 const api=(path:string,value?:ObjectValue)=>flowDoor(new Request(new URL('/api/handset/flows'+path,url),{method:value?'POST':'GET'}),env,actor,value)
 const inventory=await (await api('')).json() as FlowSnapshot
 const isOwner=actor.operator.role==='owner',references=flowReferences(inventory.versions.map(v=>JSON.parse(v.definition) as FlowDefinition))
 const filter=(ids:string[])=>isOwner?'':` WHERE id IN (${ids.length?ids.map(()=>'?').join(','):'NULL'})`
 const permissions=await Promise.all([...new Set(inventory.versions.map(v=>v.flow_id))].map(id=>authorizeFlow(env,actor,id,'flow.read')))
 const metadata=await env.DB.batch([...permissions.flatMap(p=>p.fences),
  sql(env,'SELECT id,name FROM hnd_queues'+filter(references.queues)+' ORDER BY name LIMIT 100',...(isOwner?[]:references.queues)),
  sql(env,'SELECT id,display_name FROM oa_operators'+filter(references.people)+(isOwner?" WHERE status='active'":" AND status='active'")+' ORDER BY display_name LIMIT 100',...(isOwner?[]:references.people)),sql(env,'DELETE FROM hnd_guard')])
 const queues=metadata.at(-3)!.results as unknown as {id:string;name:string}[]
 inventory.people=metadata.at(-2)!.results as unknown as {id:string;display_name:string}[]
 inventory.owner=isOwner;inventory.draftFlows=[];inventory.testFlows=[]
 for(const id of new Set(inventory.versions.map(v=>v.flow_id)))for(const [capability,target] of [['flow.draft',inventory.draftFlows],['flow.test',inventory.testFlows]] as const){
  try{await authorizeFlow(env,actor,id,capability);target.push(id)}catch(error){if(!(error instanceof Fault&&error.status===403))throw error}
 }
 const personName=(id:string)=>inventory.people!.find(p=>p.id===id)?.display_name??id
 const parts=suffix.split('/').filter(Boolean),selected=parts[0]&&parts[0]!=='save'?inventory.versions.find(row=>row.id===parts[0]):undefined
 if(parts[0]&&parts[0]!=='save'&&!selected)throw new Fault('flow_version_missing',404)
 if(request.method==='GET')return flowsPage(inventory,queues,selected)
 if(request.method!=='POST')throw new Fault('method_not_allowed',405)
 let draft:FlowDefinition|undefined,editing=selected
 try{
  if(suffix==='/save'){
   if(!isOwner)await authorizeFlow(env,actor,text(v!.flowId,'flowId'),'flow.draft')
   const d=fromForm(v!);draft=d
   if(v!.previousVersionId)editing=inventory.versions.find(row=>row.id===v!.previousVersionId)
   // The form has no prompt controls: keep the previous version's pins on steps that still exist.
   if(editing)for(const old of (JSON.parse(editing.definition) as FlowDefinition).nodes)if(old.prompt){const same=d.nodes.find(n=>n.id===old.id);if(same)same.prompt=old.prompt}
   if(typeof v!.operation==='string'&&v!.operation.startsWith('remove:')){
    const index=Number(v!.operation.slice(7));if(!Number.isSafeInteger(index)||index<0||index>=d.nodes.length||d.nodes.length===1)throw new Fault('invalid_step_removal')
    d.nodes.splice(index,1)
    const original=v!.previousVersionId?inventory.versions.find(row=>row.id===v!.previousVersionId):undefined
    return flowsPage(inventory,queues,original,'Step removed from the unsaved preview. Update its connections before saving.',d)
   }
   if(v!.operation==='add'){
    if(d.nodes.length>=50)throw new Fault('too_many_nodes')
    let ordinal=d.nodes.length+1;while(d.nodes.some(n=>n.id==='step-'+ordinal))ordinal++
    d.nodes.push({id:'step-'+ordinal,kind:'end',next:[]})
    const original=v!.previousVersionId?inventory.versions.find(row=>row.id===v!.previousVersionId):undefined
    return flowsPage(inventory,queues,original,'Connect the new step before saving. This preview has not been saved.',d)
   }
   const saved=await (await api('',{definition:definition(d),...(v!.flowId?{flowId:v!.flowId,previousVersionId:v!.previousVersionId}:{})})).json() as {id:string}
   return new Response(null,{status:303,headers:{location:'/app/flows/'+saved.id}})
  }
  if(!selected||parts.length!==2)throw new Fault('not_found',404)
  const d=JSON.parse(selected.definition) as FlowDefinition
  const scenario={instant:v!.instant,choices:Object.fromEntries(d.nodes.filter(n=>n.kind==='menu').map(n=>[n.id,v!['choice-'+n.id]])),groups:Object.fromEntries(d.nodes.filter(n=>n.group).map(n=>[n.id,{members:n.group!.members.map((id,i)=>({id,eligible:v![`eligible-${n.id}-${i}`]==='yes',...(v![`idle-${n.id}-${i}`]?{idleSince:v![`idle-${n.id}-${i}`]}:{})})),...(n.group!.strategy==='round_robin'?{cursor:Number(v!['cursor-'+n.id])}:{})}]))}
  const action=parts[1],value=action==='test'?{path:parseJSON(v!.path)}:action==='evaluate'?scenario:{revision:Number(v!.revision),confirm:v!.confirm}
  const result=await api('/'+selected.id+'/'+action,value)
  if(action==='evaluate'){
   const data=await result.json() as {path:string[];localDate:string;localMinute:number;timezone:string;overrideApplied:boolean;group?:{selected:string[];nextCursor:number|null}}
   return consolePage('Native scenario evaluated',`<p role="status">Preview only. No live routing or audible call.</p><p>Version ${selected.version} · ${e(data.timezone)} · ${e(data.localDate)} · Local time ${String(Math.floor(data.localMinute/60)).padStart(2,'0')}:${String(data.localMinute%60).padStart(2,'0')} · ${data.overrideApplied?'Holiday override':'Weekly hours'}</p><ol>${data.path.map(step=>`<li>${e(step)}</li>`).join('')}</ol>${data.group?`<p>Selected group members: ${e(data.group.selected.map(personName).join(', ')||'None eligible')}${data.group.nextCursor!==null?' · Next starting member '+e(personName(d.nodes.find(n=>n.id===data.path.at(-1))!.group!.members[data.group.nextCursor])):''}</p>`:''}<a href="/app/flows/${e(selected.id)}">Return to exact flow version</a>`)
  }
  return new Response(null,{status:303,headers:{location:'/app/flows/'+selected.id}})
 }catch(error){
  if(error instanceof Fault)return flowsPage(inventory,queues,editing,error.code.replaceAll('_',' '),draft,error.status)
  throw error
 }
}
