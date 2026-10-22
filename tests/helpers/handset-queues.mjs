import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { post, signIn } from './handset-auth.mjs'

export async function queueFixture(runtime,cookie){
 cookie??=(await signIn(runtime)).cookie
 const headers={cookie},base='/api/handset/queues'
 async function write(path,value,status=200){
  const response=await post(runtime,path,value,headers)
  assert.equal(response.status,status,await response.clone().text());return response.json()
 }
 async function read(){const response=await runtime.request(base,{headers});assert.equal(response.status,200,await response.clone().text());return response.json()}
 const createQueue=(name,extra={})=>write(base,{name,mode:'longest_idle',skills:[],maxWaitSeconds:120,wrapSeconds:30,maxWaiting:100,overflowKind:'voicemail',confirm:'approve native queue policy',...extra},201)
 const sales=await createQueue('Sales / Ventas'),support=await createQueue('Support / Soporte')
 const english='synthetic-handset-1',spanish='synthetic-handset-610'
 await runtime.sql('INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES (?,?,?,?,?,?)',spanish,spanish+'@example.test','Rosa García','member','active',Date.now())
 for(const [operatorId,languages] of [[english,['en']],[spanish,['es']]]){
  await write(base+'/agents',{operatorId,languages,skills:['service'],capacity:1,confirm:'approve native agent capabilities'},201)
  const current=(await read()).agents.find(a=>a.operator_id===operatorId)
  await write(base+'/presence',{operatorId,availability:'available',revision:current.revision})
  for(const q of [sales,support])await write(base+'/'+q.id+'/memberships',{operatorId,loggedIn:1,confirm:'approve queue membership'})
 }
 let sequence=700
 async function admit(q,language='en',priority=0){
  const record=await write('/api/handset/records',{kind:'call_session',sourceId:'synthetic-handset-'+sequence++,occurredAt:Date.now(),data:{direction:'inbound',state:'unknown'}},201)
  return (await write(base+'/'+q.id+'/entries',{callId:record.record.id,language,skills:[],priority},201)).entry
 }
 async function changeMembership(q,operatorId,loggedIn){
  const m=(await read()).memberships.find(m=>m.queue_id===q.id&&m.operator_id===operatorId)
  return write(base+'/'+q.id+'/memberships',{operatorId,loggedIn,priority:m.priority,revision:m.revision,confirm:'approve queue membership'})
 }
 async function presence(operatorId,availability='available'){
  const a=(await read()).agents.find(a=>a.operator_id===operatorId)
  return write(base+'/presence',{operatorId,availability,revision:a.revision})
 }
 async function action(entryId,action){
  const e=(await read()).entries.find(e=>e.id===entryId)
  return write(base+'/entries/'+entryId+'/'+action,{revision:e.revision})
 }
 return {runtime,cookie,headers,base,sales,support,english,spanish,write,read,createQueue,admit,changeMembership,presence,action}
}

// Network fakes live only at the provider edge. The Worker still verifies the
// actual Twilio HMAC contract and performs the official Call-resource request.
// https://www.twilio.com/docs/usage/security
// https://www.twilio.com/docs/voice/api/call-resource
export function queueProviderFixture(runtime,source,binding){
 function resource(index,fields={}){
  const sid='synthetic-handset-'+(900+index),from='+1512555'+String(100+index).padStart(4,'0')
  source.resource('Calls',sid,{direction:'inbound',from,to:'+15125550125',status:'in-progress',date_created:new Date(Date.now()-10000).toUTCString(),...fields})
  runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${source.account}/Calls.json?ParentCallSid=${sid}&PageSize=100`,{calls:[],next_page_uri:null})
  return {CallSid:sid,From:from,To:'+15125550125',CallStatus:'in-progress'}
 }
 function callback(fields,{signature=true,signedOrigin=runtime.origin,path=binding.callbackPath}={}){
  const data={AccountSid:source.account,...fields},parameters=new URLSearchParams(data)
  let signed=signedOrigin+path
  for(const key of Object.keys(data).sort())signed+=key+data[key]
  return runtime.request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...(signature?{'x-twilio-signature':createHmac('sha1','synthetic-handset-500').update(signed).digest('base64')}:{})},body:parameters.toString()})
 }
 function child(index,parent,destination,status='ringing',fields={}){
  const sid='synthetic-handset-'+(1200+index),prior=runtime.twilioResources.get(`https://api.twilio.com/2010-04-01/Accounts/${source.account}/Calls/${sid}.json`),start=prior?.start_time??new Date(Date.now()-1000).toUTCString(),end=new Date().toUTCString()
  const data={direction:'outbound-dial',parent_call_sid:parent.CallSid,to:destination,from:parent.From,status,date_created:prior?.date_created??new Date(Date.now()-1000).toUTCString(),start_time:['in-progress','completed'].includes(status)?start:null,end_time:status==='completed'?end:null,duration:status==='completed'?String(Math.floor((Date.parse(end)-Date.parse(start))/1000)):null,...fields}
  source.resource('Calls',sid,data)
  runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${source.account}/Calls.json?ParentCallSid=${parent.CallSid}&PageSize=100`,{calls:[{account_sid:source.account,sid,...data}],next_page_uri:null})
  return sid
 }
 function parent(call,fields={}){source.resource('Calls',call.CallSid,{direction:'inbound',from:call.From,to:call.To,status:'in-progress',date_created:new Date(Date.now()-10000).toUTCString(),...fields})}
 function status(offer,childSid,fields={}){return callback({CallSid:childSid,ParentCallSid:offer.parent_call_sid,CallStatus:'in-progress',...fields},{path:binding.callbackPath+'/offers/'+offer.id+'/status'})}
 function action(offer,fields={}){return callback({CallSid:offer.parent_call_sid,DialCallSid:offer.child_call_sid,DialCallStatus:'completed',DialBridged:'true',...fields},{path:binding.callbackPath+'/offers/'+offer.id+'/action'})}
 return {resource,callback,child,parent,status,action}
}

export async function authorizeQueueMedia(f,source){
 const destinations={
  [f.english]:'sip:synthetic-handset-611@synthetic-handset-612.example.test',
  [f.spanish]:'sip:synthetic-handset-613@synthetic-handset-614.example.test',
 }
 for(const [operatorId,destination] of Object.entries(destinations))await f.write(f.base+'/agents/'+operatorId+'/route',{sourceId:source.source.id,kind:'sip',destination,confirm:'approve exact queue agent route'})
 const overflowUrl='https://synthetic-handset-620.example.test/voicemail'
 for(const q of [f.sales,f.support])await f.write(f.base+'/overflow/'+q.id+'/route',{url:overflowUrl,confirm:'approve exact queue overflow route'})
 const binding=await f.write(f.base+'/sources',{sourceId:source.source.id,queueId:f.sales.id,language:'en',spanishDigit:'2',confirm:'authorize signed inbound queue routing'},201)
 return {destinations,overflowUrl,binding,edge:queueProviderFixture(f.runtime,source,binding)}
}
