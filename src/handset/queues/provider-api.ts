import { Fault } from '../core'
import type { Context } from './storage'

export interface ProviderCall {sid:string;account_sid:string;parent_call_sid:string|null;to:string;from:string;direction:string;status:string;date_created:string;start_time:string|null;end_time:string|null;duration:string|null}
const terminal=['completed','busy','failed','no-answer','canceled']
export const callTerminal=(state:string)=>terminal.includes(state)
export const callUrl=(account:string,sid:string)=>`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}/Calls/${encodeURIComponent(sid)}.json`
async function read(ctx:Context,url:string,account:string){
 let response:Response
 try{response=await fetch(url,{headers:{authorization:'Basic '+btoa(account+':'+ctx.env.HANDSET_TWILIO_AUTH_TOKEN)},redirect:'manual',signal:AbortSignal.timeout(5000)})}catch{throw new Fault('queue_call_readback_unavailable',503)}
 if(response.status!==200)throw new Fault('queue_call_readback_unavailable',503)
 try{return await response.json() as Record<string,unknown>}catch{throw new Fault('invalid_queue_call_readback',502)}
}
export async function readCall(ctx:Context,account:string,sid:string){
 const call=await read(ctx,callUrl(account,sid),account) as unknown as ProviderCall
 if(call.account_sid!==account||call.sid!==sid||!['queued','initiated','ringing','in-progress',...terminal].includes(call.status))throw new Fault('queue_call_readback_identity_mismatch',502)
 return call
}
export async function readChildren(ctx:Context,account:string,parent:string){
 const url=`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}/Calls.json?ParentCallSid=${encodeURIComponent(parent)}&PageSize=100`
 const list=await read(ctx,url,account)
 if(!Array.isArray(list.calls)||list.calls.length>100||list.next_page_uri)throw new Fault('queue_child_readback_ambiguous',409)
 return list.calls as ProviderCall[]
}
export async function cancelRinging(ctx:Context,account:string,child:string){
 let response:Response
 try{response=await fetch(callUrl(account,child),{method:'POST',headers:{authorization:'Basic '+btoa(account+':'+ctx.env.HANDSET_TWILIO_AUTH_TOKEN),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({Status:'canceled'}),redirect:'manual',signal:AbortSignal.timeout(5000)})}catch{throw new Fault('queue_cancel_uncertain',409)}
 // A positive HTTP response is not terminal proof. Always use GET afterwards.
 if(response.status!==200)throw new Fault('queue_cancel_uncertain',409)
}
