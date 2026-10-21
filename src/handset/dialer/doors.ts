import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, input, integer, json, keys, object, owner, session, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import { approveList, qualify, readyAgent, recipientCheck, revoke, standingPolicy } from './configuration'
import { createSession, launch, sessionAction } from './launch'
import { dialerPage } from './pages'
import { report, snapshot } from './read'
import { disposition, reconcileAttempt } from './readback'
import { attempt } from './storage'
export async function dialerDoor(request:Request,env:Bindings,actor:Session,data?:ObjectValue):Promise<Response|null>{
 const url=new URL(request.url),html=url.pathname.startsWith('/app/'),base=html?'/app/dialer':'/api/handset/dialer',path=url.pathname
 if(path!==base&&!path.startsWith(base+'/'))return null
 const checked=await session(request,env);if(checked.session.id!==actor.id)throw new Fault('session_mismatch',403);owner(checked.session)
 const ctx={env:checked.env,actor:checked.session}
 if(request.method==='GET'){
  keys(Object.fromEntries(url.searchParams),[])
  if(path===base){await commit(ctx.env,ctx.actor,'product.access','installation','completed');const result=await snapshot(ctx);return html?dialerPage(result):json(result)}
  const match=path.match(new RegExp('^'+base+'/lists/([^/]+)/report$'))
  if(match){await commit(ctx.env,ctx.actor,'product.access',match[1],'completed');return json(await report(ctx,match[1]))}
  return null
 }
 if(request.method!=='POST')throw new Fault('method_not_allowed',405)
 let value=data??await input(request,2097152)
 if(html){
  if('payload' in value){keys(value,['payload']);try{value=object(JSON.parse(String(value.payload)))}catch{throw new Fault('invalid_approval_json')}}
  if(value.previewRecipient==='')delete value.previewRecipient
 }
 let result:unknown,status=200
 const sessionMatch=path.match(new RegExp('^'+base+'/sessions/([^/]+)/(launch|pause|resume)$')),listMatch=path.match(new RegExp('^'+base+'/lists/([^/]+)/(sessions|recipients/([0-9]+)/verify)$')),revokeMatch=path.match(new RegExp('^'+base+'/(lists|qualifications|policies)/([^/]+)/revoke$')),attemptMatch=path.match(new RegExp('^'+base+'/attempts/([^/]+)/(reconcile|disposition)$'))
 if(path===base+'/qualifications'){result=await qualify(ctx,value);status=201}
 else if(path===base+'/policies'){result=await standingPolicy(ctx,value);status=201}
 else if(path===base+'/lists'){result=await approveList(ctx,value);status=201}
 else if(path===base+'/ready')result=await readyAgent(ctx,value)
 else if(sessionMatch)result=sessionMatch[2]==='launch'?await launch(ctx,sessionMatch[1],value):await sessionAction(ctx,sessionMatch[1],sessionMatch[2] as 'pause'|'resume',value)
 else if(listMatch){if(listMatch[2]==='sessions'){result=await createSession(ctx,listMatch[1],value);status=201}else result=await recipientCheck(ctx,listMatch[1],integer(Number(listMatch[3]),'ordinal',0,99),value)}
 else if(revokeMatch){keys(value,[]);result=await revoke(ctx,revokeMatch[1] as 'lists'|'qualifications'|'policies',revokeMatch[2])}
 else if(attemptMatch){if(attemptMatch[2]==='disposition')result=await disposition(ctx,attemptMatch[1],value);else{keys(value,[]);result=await reconcileAttempt(ctx,await attempt(ctx,attemptMatch[1]))}}
 else return null
 return html?dialerPage(await snapshot(ctx),'Saved. Inspect retained progress and current evidence below.'):json(result,status)
}
