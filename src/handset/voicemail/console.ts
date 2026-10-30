import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, choice, keys, type ObjectValue } from '../core'
import { denied } from '../audit/store'
import { deliverySettingsPage } from './delivery-pages'
import { deliveryView } from './delivery'
import { voicemailLinkDoor } from './links'
import { voicemailDoor, type ListedBox, type MailboxView } from './doors'
import { mailboxCreate, mailboxDetail, mailboxList, mailboxSettings, mailboxUnavailable, type Refusal } from './pages'

/** HTML forms use the same current-authority and transaction fences as the API. */
export async function voicemailConsole(request:Request,env:Bindings,actor:Session,raw?:ObjectValue):Promise<Response>{
 const url=new URL(request.url),base='/app/voicemail',suffix=url.pathname.slice(base.length)
 if(suffix.startsWith('/links/'))return voicemailLinkDoor(request,env,actor,raw)
 const delivery=suffix.match(/^\/settings\/([0-9a-f-]{36})\/delivery(?:\/(policy|links\/([0-9a-f-]{36})\/revoke))?$/)
 if(delivery){
  const boxId=delivery[1],view=await (await voicemailDoor(new Request(new URL('/api/handset/voicemail/boxes/'+boxId,url)),env,actor)).json() as MailboxView
  let refusal:Refusal|undefined
  if(request.method==='POST'&&raw){
   try{
    if(delivery[3])await voicemailLinkDoor(new Request(new URL('/api/handset/voicemail/links/'+delivery[3]+'/revoke',url),{method:'POST'}),env,actor,{})
    else {
     let choice:ObjectValue={}
     if(delivery[2]!=='policy'){try{choice=JSON.parse(String(raw.recipientChoice)) as ObjectValue}catch{throw new Fault('invalid_recipient_choice')}keys(raw,['recipientChoice','mode','enabled','linkSeconds','confirm'])}
     await voicemailDoor(new Request(new URL('/api/handset/voicemail/boxes/'+boxId+'/'+(delivery[2]==='policy'?'delivery-policy':'delivery'),url),{method:'POST'}),env,actor,delivery[2]==='policy'?{...raw,revision:Number(raw.revision),linkOnly:Number(raw.linkOnly)}:{...choice,mode:raw.mode,confirm:raw.confirm,enabled:Number(raw.enabled),linkSeconds:Number(raw.linkSeconds)})
    }
    return new Response(null,{status:303,headers:{location:base+'/settings/'+boxId+'/delivery','cache-control':'no-store'}})
   }catch(error){if(!(error instanceof Fault)||[401,403].includes(error.status))throw error;refusal={code:error.code,status:error.status,values:raw,action:'delivery'}}
  }else if(request.method!=='GET')throw new Fault('method_not_allowed',405)
  return deliverySettingsPage(view,await deliveryView(env,actor,boxId),refusal)
 }
 const creating=suffix==='/settings/new',settings=suffix==='/settings'||suffix.startsWith('/settings/')
 const match=suffix.match(/^\/(?:settings\/)?([0-9a-f-]{36})(?:\/(members|owner|observations|items)(?:\/([0-9a-f-]{36})(?:\/(claim|handle|reopen|assign|note|content|deliver))?)?)?$/)
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
     }else if(action==='content'){keys(raw,['recordingId','transcriptId']);value=raw}
     else if(action==='deliver'){keys(raw,['settingId','dueAt','confirm']);value={...raw,dueAt:new Date(String(raw.dueAt)+'Z').getTime()}}
     else if(action==='observations'){keys(raw,['sourceId','text','language']);value=raw}
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
  if(view)return settings?mailboxSettings(view,refusal):mailboxDetail(view,itemId,refusal,view.box.owner_id===actor.operator.id?await deliveryView(env,actor,view.box.id):undefined)
  const data=await (await api('')).json() as {boxes:ListedBox[]}
  return mailboxList(data.boxes,settings)
 }catch(error){
  const reload=boxId?base+'/'+boxId+(itemId?'/items/'+itemId:''):base
  if(error instanceof Fault){await denied(env,actor,'product.request');return mailboxUnavailable(error.status,reload)}
  console.error('Mailbox request failed',error instanceof Error?error.name:'unknown')
  return mailboxUnavailable(503,reload)
 }
}
