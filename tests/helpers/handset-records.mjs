import assert from 'node:assert/strict'
import { post } from './handset-auth.mjs'

export async function recordsFixture(runtime, cookie) {
 const headers={cookie}
 async function create(path,value){const response=await post(runtime,path,value,headers);assert.equal(response.status,201,await response.clone().text());return response.json()}
 const detail=await create('/api/handset/cases',{title:'Austin service callback / Devolución de llamada',promise:'Confirm the replacement appointment',dueAt:Date.now()+86400000})
 const caseId=detail.current.id
 const entries={}
 async function entry(kind,data,parentId,links=[]){
  const result=await create('/api/handset/records',{kind,data,sourceId:`synthetic-handset-${Object.keys(entries).length+20}`,occurredAt:Date.now(),caseId,parentId,links})
  entries[kind]=result.record
  return result.record.id
 }
 const company=await entry('company',{name:'Austin Service Co.'})
 const location=await entry('location',{name:'Congress Avenue',timezone:'America/Chicago'},company,[{targetId:company,relation:'company'}])
 const number=await entry('number',{e164:'+15125550142'},location)
 const person=await entry('person',{name:'Rosa García'},company)
 const endpoint=await entry('endpoint',{name:'Front desk',platform:'web'},person)
 const flow=await entry('flow_version',{name:'Spanish support',revision:'1'},number)
 const session=await entry('call_session',{direction:'inbound',state:'uncertain'},number,[{targetId:person,relation:'person'},{targetId:flow,relation:'flow'}])
 const leg=await entry('call_leg',{state:'uncertain'},session,[{targetId:endpoint,relation:'endpoint'}])
 await entry('call_leg',{state:'uncertain',transferFrom:leg},leg)
 await entry('queue_entry',{state:'pending'},session)
 await entry('callback',{state:'pending',dueAt:Date.now()+86400000},session)
 const conversation=await entry('conversation',{subject:'Replacement appointment'},session)
 await entry('message',{channel:'voicemail',direction:'inbound',state:'unknown',text:'Requested a callback'},conversation)
 await entry('message',{channel:'mms',direction:'outbound',state:'uncertain',text:'Photo delivery is not confirmed'},conversation)
 const media=await entry('media',{name:'Synthetic photo',mime:'image/png',sizeBytes:256},conversation)
 await entry('consent',{purpose:'One callback',state:'held'},person)
 await entry('recording',{name:'Unverified voicemail reference',state:'unknown'},media)
 await entry('transcript',{text:'Synthetic request for a replacement appointment',language:'es'},media)
 await entry('disposition',{text:'Awaiting customer confirmation'},session)
 await entry('promise',{text:'Confirm the appointment',dueAt:Date.now()+86400000},conversation)
 await entry('provider_attempt',{operation:'send',state:'uncertain'},conversation)
 await entry('usage',{amountCents:0,currency:'USD'},session)
 await entry('comment',{text:'Please follow up / Por favor confirma',mention:person},conversation,[{targetId:person,relation:'mentions'}])
 return {detail,caseId,entries,create}
}
