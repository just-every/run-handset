import assert from 'node:assert/strict'
import { sourceFixture } from './handset-sources.mjs'
import { post } from './handset-auth.mjs'
export const messageNow=Date.UTC(2026,9,27,18)
export async function messagesFixture(runtime,{business='+18335550125',recipient='+15125550126'}={}) {
 const source=await sourceFixture(runtime,{e164:business,sourceId:'synthetic-handset-1800-'+business.slice(-4)}),headers=source.headers,base='/api/handset/messages',now=messageNow
 async function write(path,value,status=201){const r=await post(runtime,path.startsWith('/api/')?path:base+path,value,headers);assert.equal(r.status,status,await r.clone().text());return r.json()}
 async function get(path=''){const r=await runtime.request(base+path,{headers});assert.equal(r.status,200,await r.clone().text());return r.json()}
 const registrationId='synthetic-handset-1800-'+business.slice(-4)
 await write('/api/handset/consent/policies',{sourceId:source.source.id,businessName:'Cedar Creek Heating',legalConfiguration:'Reviewed explicit customer-care permission only, no marketing.',registrationId,staffTarget:'+15125551099',expiresAt:now+86400000,confirm:'approve exact informational consent policy'})
 const registration={sid:registrationId,account_sid:source.account,tollfree_phone_number:business,status:'TWILIO_APPROVED'}
 runtime.twilioResources.set('https://messaging.twilio.com/v1/Tollfree/Verifications/'+registrationId,registration)
 await write('/api/handset/consent/recipients',{recipient,timezone:'America/Chicago',startMinute:480,endMinute:1260,expiresAt:now+86400000,confirm:'approve recipient timezone and hours'})
 let incomingNumber=0
 const incoming=async(body,extras={})=>{const r=await source.callback({MessageSid:'synthetic-handset-1801-'+business.slice(-4)+'-'+(++incomingNumber),From:recipient,MessageStatus:'received',Body:body,Timestamp:new Date(now).toISOString(),...extras});assert.equal(r.status,200,await r.clone().text());return r.json()}
 async function current(){return (await get()).threads.find(t=>t.source_id===source.source.id&&t.peer===recipient)}
 async function claimed(){let t=await current();if(!t){await incoming('Please help with our heating appointment');t=await current()}if(!t.owner_id)await write('/threads/'+t.id+'/claim',{revision:t.revision},200);return current()}
 async function draft({media=[],dueAt=now,body='We will check your heating appointment and follow up.',permissionId}={}) {
  const t=await claimed(),snippet=await write('/snippets',{name:'Heating appointment',body})
  const permitted=permissionId?{permission:{id:permissionId}}:await write('/permissions',{recipient,purpose:'customer-care',evidence:'Customer explicitly requested customer-care texts about this appointment; reviewed by Mara Patel.',expiresAt:now+86400000,confirm:'I verified explicit permission for customer-care texts'})
  return (await write('/threads/'+t.id+'/schedule',{revision:t.revision,snippetId:snippet.snippet.id,snippetRevision:snippet.snippet.revision,dueAt,permissionId:permitted.permission.id,media})).job
 }
 async function queued(options){const j=await draft(options);return (await write('/jobs/'+j.id+'/approve',{revision:j.revision,confirm:'approve exact scheduled message'},200)).job}
 const receiver={sent:[],drop:false,hook:null}
 runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${source.account}/Messages.json`,async request=>{
  const form=new URLSearchParams(await request.text()),sid='synthetic-handset-1802-'+(receiver.sent.length+1)
  const message={sid,account_sid:source.account,from:form.get('From'),to:form.get('To'),body:form.get('Body'),num_media:form.getAll('MediaUrl').length,direction:'outbound-api',status:'queued',date_created:new Date(now).toUTCString()}
  receiver.sent.push({form,message});source.resource('Messages',sid,message)
  if(receiver.drop){receiver.drop=false;throw new Error('synthetic-handset-lost-response')}
  return {...message,__httpStatus:201}
 })
 return {runtime,source,headers,recipient,business,base,now,write,get,incoming,current,claimed,draft,queued,receiver,registration}
}
