import assert from 'node:assert/strict'
import { signIn, post } from './handset-auth.mjs'

export async function numberFixture(runtime,cookie){
 cookie??=(await signIn(runtime)).cookie
 const account='synthetic-handset-7000',root=`https://api.twilio.com/2010-04-01/Accounts/${account}`,headers={cookie}
 const numbers=['+15125550125','+18335550125','+15125550126'],owned=new Map(),calls=[]
 let sequence=7001,uncertain=false,deletingUncertain=false,emergency=false,route=false,noResults=false,changedPrice=false
 runtime.twilioResources.set(root+'.json',{sid:account,status:'active',type:'Full'})
 const catalog=(country,kind,area)=>{
  const e164=kind==='local'?numbers[0]:numbers[1]
  runtime.twilioResources.set(`${root}/AvailablePhoneNumbers/${country}/${kind==='local'?'Local':'TollFree'}.json?PageSize=20&AreaCode=${area}`,()=>({available_phone_numbers:noResults?[]:[{phone_number:e164,iso_country:country,capabilities:{voice:true,SMS:true,MMS:kind==='local'}}]}))
 }
 catalog('US','local','512');catalog('US','tollfree','833')
 runtime.twilioResources.set('https://pricing.twilio.com/v1/PhoneNumbers/Countries/US',()=>({iso_country:'US',price_unit:'usd',phone_number_prices:[{number_type:'local',current_price:changedPrice?'2.00':'1.15'},{number_type:'toll free',current_price:'2.15'}]}))
 runtime.twilioResources.set(root+'/IncomingPhoneNumbers.json',async request=>{
  const body=new URLSearchParams(await request.text());calls.push({method:request.method,phone:body.get('PhoneNumber')})
  const receipt={sid:'synthetic-handset-'+sequence++,account_sid:account,phone_number:body.get('PhoneNumber'),friendly_name:body.get('FriendlyName'),emergency_status:'Inactive',emergency_address_sid:null,address_sid:null,voice_url:'',voice_application_sid:null,trunk_sid:null}
  owned.set(receipt.sid,receipt)
  runtime.twilioResources.set(`${root}/IncomingPhoneNumbers/${receipt.sid}.json`,request=>{
   if(request.method==='DELETE'){calls.push({method:'DELETE',phone:receipt.phone_number});owned.delete(receipt.sid);return {__httpStatus:deletingUncertain?503:204}}
   return {...receipt,emergency_status:emergency?'Active':'Inactive',voice_url:route?'https://example.test/live':''}
  })
  runtime.twilioResources.set(root+'/IncomingPhoneNumbers.json?'+new URLSearchParams({PhoneNumber:receipt.phone_number,PageSize:'2'}),()=>({incoming_phone_numbers:[...owned.values()].filter(n=>n.phone_number===receipt.phone_number)}))
  return uncertain?{__httpStatus:503}:{...receipt,__httpStatus:201}
 })
 const send=(path,v)=>post(runtime,'/api/handset/numbers'+path,v,headers)
 const value=async response=>{assert.ok(response.ok,await response.clone().text());return response.json()}
 const search=async(kind='local')=>(await value(await send('/search',{accountId:account,country:'US',kind,areaCode:kind==='local'?'512':'833'}))).quotes
 const approval=(quote,key='synthetic-handset-'+sequence++)=>({quoteId:quote.id,requestKey:key,assignment:'Austin · Equipo de atención',purpose:'Customer appointments / Citas',campaign:'',confirm:'approve exact number and carrier charges under my direct contract'})
 const buy=async(kind='local')=>{const q=(await search(kind))[0],input=approval(q);return {...await value(await send('/purchase',input)),input}}
 return {account,root,headers,cookie,calls,owned,send,value,search,approval,buy,
  setUncertain:v=>uncertain=v,setReleaseUncertain:v=>deletingUncertain=v,setEmergency:v=>emergency=v,setRoute:v=>route=v,setEmpty:v=>noResults=v,setChangedPrice:v=>changedPrice=v,
  review:(n,replacement)=>({revision:n.revision,replacementId:replacement.id,replacementRevision:replacement.revision,confirm:'approve exact number release after reviewed reassignment'}),
  release:n=>({revision:n.revision,confirm:'release exact number and stop carrier service'}),
  async inventory(){return (await value(await runtime.request('/api/handset/numbers',{headers}))).numbers},
 }
}
