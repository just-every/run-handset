import { Fault } from '../core'
import { readCall, type ProviderCall } from '../queues/provider-api'
import type { Context } from './storage'
import type { Ready } from './model'
export const accountBase=(account:string)=>`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}`
export async function providerGet(ctx:Context,account:string,path:string){
 if(!ctx.env.HANDSET_TWILIO_AUTH_TOKEN)throw new Fault('provider_credentials_unavailable',503)
 let response:Response;try{response=await fetch(accountBase(account)+path,{headers:{authorization:'Basic '+btoa(account+':'+ctx.env.HANDSET_TWILIO_AUTH_TOKEN)},redirect:'manual',signal:AbortSignal.timeout(5000)})}catch{throw new Fault('dialer_readback_unavailable',503)}
 if(response.status!==200)throw new Fault('dialer_readback_unavailable',503)
 try{return await response.json() as Record<string,unknown>}catch{throw new Fault('invalid_dialer_readback',502)}
}
export async function ownedFrom(ctx:Context,account:string,numberSid:string,from:string){const row=await providerGet(ctx,account,'/IncomingPhoneNumbers/'+encodeURIComponent(numberSid)+'.json');if(row.sid!==numberSid||row.account_sid!==account||row.phone_number!==from||!row.capabilities||typeof row.capabilities!=='object'||!('voice' in row.capabilities)||row.capabilities.voice!==true)throw new Fault('verified_owned_from_required',409)}
export async function waitingAgent(ctx:Context,account:string,ready:Ready,destination:string){
 const [conference,participants,call]=await Promise.all([providerGet(ctx,account,'/Conferences/'+encodeURIComponent(ready.conference_sid)+'.json'),providerGet(ctx,account,'/Conferences/'+encodeURIComponent(ready.conference_sid)+'/Participants.json?PageSize=100'),readCall(ctx,account,ready.agent_call_sid)])
 if(conference.sid!==ready.conference_sid||conference.account_sid!==account||conference.friendly_name!==ready.conference_name||conference.status!=='in-progress'||!Array.isArray(participants.participants)||participants.next_page_uri||participants.participants.length!==1||participants.participants[0]?.call_sid!==ready.agent_call_sid||participants.participants[0]?.status!=='connected'||participants.participants[0]?.account_sid!==account||participants.participants[0]?.conference_sid!==ready.conference_sid||participants.participants[0]?.muted!==false||participants.participants[0]?.hold!==false||participants.participants[0]?.coaching===true||call.status!=='in-progress'||!['outbound-api','outbound-dial'].includes(call.direction)||![destination,destination.replace(/^sips?:/,''),'client:'+destination].includes(call.to))throw new Fault('waiting_agent_media_unconfirmed',409)
 return call
}
export function verifyRecipientCall(call:ProviderCall,account:string,from:string,to:string,created:number){if(call.account_sid!==account||call.from!==from||call.to!==to||call.direction!=='outbound-api'||!Number.isFinite(Date.parse(call.date_created))||Date.parse(call.date_created)<created-1000)throw new Fault('dialer_call_identity_mismatch',502)}
