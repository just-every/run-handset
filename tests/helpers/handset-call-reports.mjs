import assert from 'node:assert/strict'
import { post,signIn } from './handset-auth.mjs'
import { sourceFixture } from './handset-sources.mjs'
import { queueFixture,authorizeQueueMedia } from './handset-queues.mjs'
import { metricDataset,metricStart,metricConfig } from './handset-metrics.mjs'
import { importDataset } from './handset-import.mjs'
import { policyFor } from './handset-receptionist.mjs'

export const callReportStart=Date.parse('2026-11-01T06:00:00Z')
export const callReportNow=callReportStart+8*86400000
export async function callReportsFixture(runtime,edges){
 await runtime.setTime(callReportStart)
 const source=await sourceFixture(runtime),f=await queueFixture(runtime,source.cookie),media=await authorizeQueueMedia(f,source)
 const write=async(path,data,status=201,headers=source.headers)=>{
  const response=await post(runtime,path,data,headers);assert.equal(response.status,status,await response.clone().text());return response.json()
 }
 const calls=[]
 for(let index=0;index<6;index++){
  const at=callReportStart+index*1000,sid='synthetic-handset-report-'+index,from='+1512555'+String(index===5?8001:8000+index)
  await runtime.setTime(at)
  const initial=await source.callback({CallSid:sid,From:from,CallStatus:'in-progress',Timestamp:new Date(at).toISOString(),SequenceNumber:'0'})
  assert.equal(initial.status,200,await initial.clone().text());calls.push(await initial.json())
  if(index===0){
   const call={CallSid:sid,From:from,To:'+15125550125',CallStatus:'in-progress',Digits:'2'}
   source.resource('Calls',sid,{direction:'inbound',from,to:'+15125550125',status:'in-progress',date_created:new Date(at).toUTCString()})
   runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${source.account}/Calls.json?ParentCallSid=${sid}&PageSize=100`,{calls:[],next_page_uri:null})
   const xml=await media.edge.callback(call);assert.equal(xml.status,200,await xml.clone().text());assert.ok((await xml.text()).includes(media.destinations[f.spanish]))
   const offer=(await f.read()).offers[0]
   const child=media.edge.child(80,call,media.destinations[f.spanish],'ringing',{date_created:new Date(at).toUTCString()})
   assert.equal((await media.edge.status(offer,child)).status,204)
   await write('/api/handset/metrics/config',metricConfig('*',0,{startAt:callReportStart,endAt:callReportNow,repeatWindowHours:24}))
   const ringing=await (await runtime.request('/api/handset/metrics/live?queueId=*',{headers:source.headers})).json()
   assert.deepEqual(ringing.native.sourceCalls[0].handlingUsers,[],'a reservation and ringing child are not handling')
   assert.equal(ringing.native.conversion.excluded.immature,1);assert.equal(ringing.native.conversion.denominator,0)
   await runtime.setTime(at+65000)
   media.edge.child(80,call,media.destinations[f.spanish],'completed',{date_created:new Date(at).toUTCString(),start_time:new Date(at+5000).toUTCString(),end_time:new Date(at+65000).toUTCString(),duration:'60'})
   assert.equal((await media.edge.status(offer,child)).status,204)
   calls[0].offerId=offer.id
  }
  await runtime.setTime(at+120000)
  const terminal=await source.callback({CallSid:sid,From:from,CallStatus:index<4?'completed':'no-answer',Timestamp:new Date(at+120000).toISOString(),SequenceNumber:'1'})
  assert.equal(terminal.status,200,await terminal.clone().text());calls[index].terminalRecordId=(await terminal.json()).recordId
 }
 await runtime.setTime(callReportStart+6*3600000)
 source.cookie=(await signIn(runtime)).cookie;source.headers.cookie=source.cookie
 await write('/api/handset/receptionist/policy',{policy:policyFor('synthetic-handset-1'),expectedVersion:0,confirm:'set receptionist limits'})
 const issued=await write('/api/handset/mcp/consent',{name:'Call-bound reporting outcomes',definition:{scopes:['send'],tools:['outcome.work'],records:[...new Set(calls.map(c=>c.caseId))],numbers:[],recipients:[],budgetCents:0,policyRevision:'owner-only-v1'},expiresAt:Date.now()+3600000,confirm:'approve scoped credential'})
 const agent=(path,value,status=200)=>write('/api/handset/application/receptionist/'+path,value,status,{authorization:'Bearer '+issued.token})
 const outcomes=[]
 for(const index of [1,2,3,4]){
  const input={callId:calls[index].recordId,caseId:calls[index].caseId,language:'en',callerName:'Jordan Lee',callerEmail:'synthetic-handset-report-'+index+'@example.test',identityBasis:'callback_to_number_on_file',identityVerified:true}
  const opened=await agent('outcomes',input,201);outcomes.push(opened.outcome)
  assert.equal((await agent('outcomes',input)).outcome.id,opened.outcome.id,'same-call replay cannot multiply outcomes')
  if(index<3||index===4){
   const startAt=new Date(callReportStart+86400000+index*3600000).toISOString();edges.slots.push(startAt)
   await agent('outcomes/'+opened.outcome.id+'/availability',{serviceId:'furnace'})
   const result=await agent('outcomes/'+opened.outcome.id+'/booking',{serviceId:'furnace',startAt})
   assert.equal(result.step.state,'confirmed');assert.equal(edges.bookings.get(result.step.externalId).answers.handsetCall,calls[index].recordId)
  }
  if(index===2)await agent('outcomes/'+opened.outcome.id+'/escalations',{kind:'human_request',detail:'Customer asked for staff'})
 }
 const unlinked=await agent('outcomes',{callId:'synthetic-handset-unlinked',caseId:calls[1].caseId,language:'en',callerName:'Jordan Lee',callerEmail:'synthetic-handset-unlinked@example.test',identityBasis:'callback_to_number_on_file',identityVerified:true},201)
 const wrongCase=await agent('outcomes',{callId:calls[0].recordId,caseId:calls[1].caseId,language:'en',callerName:'Jordan Lee',callerEmail:'synthetic-handset-wrong-case@example.test',identityBasis:'callback_to_number_on_file',identityVerified:true},201)
 const wrongSlot=new Date(callReportStart+3*86400000).toISOString();edges.slots.push(wrongSlot)
 await agent('outcomes/'+wrongCase.outcome.id+'/availability',{serviceId:'furnace'})
 await agent('outcomes/'+wrongCase.outcome.id+'/booking',{serviceId:'furnace',startAt:wrongSlot})
 const recoveries=[]
 for(const index of [4,5])recoveries.push((await write('/api/handset/recovery',{callRecordId:calls[index].terminalRecordId,dueAt:Date.now()+3600000,maxAttempts:1})).recovery)
 const resolved=await write('/api/handset/recovery/'+recoveries[0].id+'/resolve',{revision:recoveries[0].revision,outcomeId:outcomes[3].id},200)
 assert.equal(resolved.recovery.state,'resolved')
 const recordingSid='synthetic-handset-call-report-recording'
 source.resource('Recordings',recordingSid,{call_sid:'synthetic-handset-report-3',status:'failed',start_time:new Date(callReportStart+3000).toISOString()})
 const failed=await source.callback({CallSid:'synthetic-handset-report-3',RecordingSid:recordingSid,RecordingStatus:'failed',From:'',To:''})
 assert.equal(failed.status,200,await failed.clone().text())
 const failedRecording=await failed.json()
 const dataset=metricDataset(),shift=callReportStart-metricStart
 for(const entry of dataset.entries){
  const index=Number(entry.callId.split('-').at(-1))-1;entry.callId=calls[index].recordId
  if(entry.agentId)entry.agentId=f.spanish
  for(const key of ['enteredAt','answeredAt','abandonedAt','closedAt'])if(entry[key]!==undefined)entry[key]+=shift+index*1000
 }
 for(const segment of dataset.agents){segment.startAt+=shift;segment.endAt+=shift;segment.agentId=f.spanish}
 await importDataset(runtime,source.cookie,dataset)
 await runtime.setTime(callReportNow)
 source.cookie=(await signIn(runtime)).cookie;source.headers.cookie=source.cookie
 const assignment=await write('/api/handset/metrics/groups',{number:'+15125550125',team:'Support',location:'Austin',trackingSource:'Winter repairs',revision:0})
 return {source,calls,dataset,outcomes,recoveries,failedRecording,wrongCase:wrongCase.outcome,unlinked:unlinked.outcome,assignment,handler:f.spanish,write}
}
