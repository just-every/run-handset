import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, choice, keys, type ObjectValue } from '../core'
import { denied } from '../audit/store'
import { voicemailDoor, type ListedBox, type MailboxView } from './doors'
import { mailboxCreate, mailboxDetail, mailboxList, mailboxSettings, mailboxUnavailable, type Refusal } from './pages'

/** HTML forms use the same current-authority and transaction fences as the API. */
export async function voicemailConsole(request:Request,env:Bindings,actor:Session,raw?:ObjectValue):Promise<Response>{
 const url=new URL(request.url),base='/app/voicemail',suffix=url.pathname.slice(base.length)
 const creating=suffix==='/settings/new',settings=suffix==='/settings'||suffix.startsWith('/settings/')
 const match=suffix.match(/^\/(?:settings\/)?([0-9a-f-]{36})(?:\/(members|owner|observations|items)(?:\/([0-9a-f-]{36})(?:\/(claim|handle|reopen|assign|note))?)?)?$/)
 if(!['GET','POST'].includes(request.method))throw new Fault('method_not_allowed',405)
 if(suffix!==''&&suffix!=='/settings'&&!creating&&!match)throw new Fault('not_found',404)
 const boxId=match?.[1],itemId=match?.[2]==='items'?match[3]:undefined,action=match?.[4]??(match?.[2]==='items'?'':match?.[2]??'')
 if(request.method==='GET'&&action||request.method==='POST'&&!creating&&!action)throw new Fault('method_not_allowed',405)
 if(settings&&action&&!['members','owner'].includes(action)||!settings&&['members','owner'].includes(action))throw new Fault('not_found',404)
 const api=async(path:string,value?:ObjectValue)=>voicemailDoor(new Request(new URL('/api/handset/voicemail/boxes'+path,url),{method:value?'POST':'GET'}),env,actor,value)
 let view:MailboxView|undefined,refusal:Refusal|undefined
 try{
  if(boxId){
   view=await (await api('/'+boxId)).json() as MailboxView
   if(settings&&!view.capabilities.admin)throw new Fault('mailbox_administration_required',403)
  }
  if(request.method==='POST'&&raw){
   try{
    let value:ObjectValue,path=''
    if(creating){keys(raw,['name','kind']);value=raw}
    else{
     if(!boxId||!view)throw new Fault('not_found',404)
     path='/'+boxId+'/'+(itemId?'items/'+itemId+'/':'')+action
     if(action==='members'){
      keys(raw,['revision','personId','enabled','capability'])
      const enabled=Number(raw.enabled),capability=choice(raw.capability??'read',['read','work','assign','work_assign'],'capability')
      value={revision:Number(raw.revision),personId:raw.personId,enabled,allowWork:['work','work_assign'].includes(capability)?1:0,allowAssign:['assign','work_assign'].includes(capability)?1:0}
     }else if(action==='observations'){keys(raw,['sourceId','text','language']);value=raw}
     else{
      keys(raw,['revision',...(action==='note'?['note','confirm']:action==='assign'||action==='owner'?['personId']:[])])
      value={revision:Number(raw.revision),...(action==='note'?{note:raw.note}:action==='assign'||action==='owner'?{personId:raw.personId}:{})}
     }
    }
    const response=await api(path,value)
    const target=creating?base+'/'+((await response.json()) as {box:{id:string}}).box.id:settings?base+'/settings/'+boxId:base+'/'+boxId+(itemId?'/items/'+itemId:'')
    return new Response(null,{status:303,headers:{location:target,'cache-control':'no-store'}})
   }catch(error){
    if(!(error instanceof Fault)||[401,403].includes(error.status))throw error
    refusal={code:error.code,status:error.status,values:raw,action}
    await denied(env,actor,'product.request')
    if(boxId)view=await (await api('/'+boxId)).json() as MailboxView
   }
  }
  if(creating)return mailboxCreate(actor.operator.role==='owner',refusal)
  if(view)return settings?mailboxSettings(view,refusal):mailboxDetail(view,itemId,refusal)
  const data=await (await api('')).json() as {boxes:ListedBox[]}
  return mailboxList(data.boxes,settings)
 }catch(error){
  const reload=boxId?base+'/'+boxId+(itemId?'/items/'+itemId:''):base
  if(error instanceof Fault){await denied(env,actor,'product.request');return mailboxUnavailable(error.status,reload)}
  console.error('Mailbox request failed',error instanceof Error?error.name:'unknown')
  return mailboxUnavailable(503,reload)
 }
}
