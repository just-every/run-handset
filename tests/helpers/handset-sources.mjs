import { createHmac } from 'node:crypto'
import assert from 'node:assert/strict'
import { post, signIn } from './handset-auth.mjs'
export async function sourceFixture(runtime,{e164='+15125550125'}={}){
 const {cookie}=await signIn(runtime),headers={cookie}
 const result=await post(runtime,'/api/handset/records',{kind:'number',sourceId:'synthetic-handset-501',occurredAt:Date.now(),data:{e164}},headers)
 assert.equal(result.status,201)
 const numberId=(await result.json()).record.id,account='synthetic-handset-502'
 const source=await post(runtime,'/api/handset/sources',{accountId:account,numberId,confirm:'authorize signed inbound records'},headers)
 assert.equal(source.status,201,await source.clone().text())
 async function callback(fields,{signature=true,origin=runtime.origin}={}){
  const data={AccountSid:account,From:'+15125550126',To:e164,...fields},parameters=new URLSearchParams(data)
  let signed=origin+'/providers/twilio/events'
  for(const key of Object.keys(data).sort())signed+=key+data[key]
  return runtime.request('/providers/twilio/events',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...(signature?{'x-twilio-signature':createHmac('sha1','synthetic-handset-500').update(signed).digest('base64')}:{})},body:parameters.toString()})
 }
 function resource(type,id,fields){runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${account}/${type}/${id}.json`,{account_sid:account,sid:id,...fields})}
 return {cookie,headers,numberId,account,source:await source.json(),callback,resource}
}
