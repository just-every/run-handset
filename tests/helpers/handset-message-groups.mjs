import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { sourceFixture } from './handset-sources.mjs'
import { post } from './handset-auth.mjs'
export async function groupsFixture(runtime,{authorize=true}={}) {
 const source=await sourceFixture(runtime,{e164:'+15125550145',sourceId:'synthetic-handset-1870'}),service='synthetic-handset-1871',conversation='synthetic-handset-1872',sid='synthetic-handset-1873'
 let binding={providerPath:'/providers/twilio/messages/groups'}
 if(authorize){const response=await post(runtime,'/api/handset/messages/group-routes',{sourceId:source.source.id,serviceSid:service,conversationSid:conversation,confirm:'authorize exact group metadata only'},source.headers)
 assert.equal(response.status,201,await response.clone().text());binding=await response.json()}
 const base=`https://conversations.twilio.com/v1/Services/${service}/Conversations/${conversation}`
 const resource={sid:conversation,account_sid:source.account,chat_service_sid:service,state:'active'}
 const members={meta:{next_page_url:null},participants:[
  {sid:'synthetic-handset-1874',account_sid:source.account,conversation_sid:conversation,messaging_binding:{projected_address:'+15125550145'}},
  {sid:'synthetic-handset-1875',account_sid:source.account,conversation_sid:conversation,messaging_binding:{address:'+15125550126'}},
  {sid:'synthetic-handset-1876',account_sid:source.account,conversation_sid:conversation,messaging_binding:{address:'+15125550127'}},
 ]}
 const message={sid,account_sid:source.account,conversation_sid:conversation,author:'+15125550126',participant_sid:'synthetic-handset-1875',body:'Both of us can meet the heating technician at 2 pm.',date_created:new Date().toISOString(),media:[{sid:'synthetic-handset-1877',content_type:'image/jpeg',filename:'heater.jpg',size:1024}]}
 runtime.twilioResources.set(base,resource);runtime.twilioResources.set(base+'/Participants?PageSize=100',members);runtime.twilioResources.set(base+'/Messages/'+sid,message)
 async function receive(fields={},signed=true) {
  const p=new URLSearchParams({EventType:'onMessageAdded',ConversationSid:conversation,ChatServiceSid:service,MessageSid:sid,Author:message.author,ParticipantSid:message.participant_sid,Body:message.body,...fields})
  let payload=runtime.origin+binding.providerPath;for(const key of [...p.keys()].sort())payload+=key+p.get(key)
  return runtime.request(binding.providerPath,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...(signed?{'x-twilio-signature':createHmac('sha1','synthetic-handset-500').update(payload).digest('base64')}:{})},body:p.toString()})
 }
 return {source,binding,resource,members,message,receive}
}
