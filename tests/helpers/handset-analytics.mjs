import assert from 'node:assert/strict'
import { sourceFixture } from './handset-sources.mjs'
import { post, signIn } from './handset-auth.mjs'
import { metricDataset, metricStart } from './handset-metrics.mjs'
import { importDataset } from './handset-import.mjs'
import { policyFor } from './handset-receptionist.mjs'
export const analyticsStart=Date.parse('2026-11-01T00:00:00Z'),analyticsEnd=Date.parse('2026-11-08T00:00:00Z'),analyticsNow=analyticsEnd+12*3600000
async function nativeWeek(runtime,{beforeCall,afterCall}={}){
 const source=await sourceFixture(runtime),calls=[]
 for(const [index,[at,status]] of [
  ['2026-11-01T06:15:00Z','no-answer'],['2026-11-01T07:15:00Z','failed'],['2026-11-02T15:00:00Z','completed'],['2026-11-03T16:00:00Z','busy'],['2026-11-04T17:00:00Z','no-answer'],['2026-11-05T18:00:00Z','canceled'],['2026-11-08T00:00:00Z','no-answer']
 ].entries()){
  await beforeCall?.(Date.parse(at))
  const response=await source.callback({CallSid:'synthetic-handset-analytics-'+index,From:index===4?'+15125554000':'+1512555'+String(4000+index),CallStatus:status,SequenceNumber:'0',Timestamp:at});assert.equal(response.status,200,await response.clone().text());calls.push(await response.json())
  await afterCall?.({source,calls,index})
 }
 const leg=await source.callback({CallSid:'synthetic-handset-analytics-leg',ParentCallSid:'synthetic-handset-analytics-2',CallStatus:'completed',SequenceNumber:'0',Timestamp:'2026-11-02T15:01:00Z'});assert.equal(leg.status,200,await leg.clone().text())
 return {source,calls}
}
export async function analyticsFixture(runtime){
 const {source,calls}=await nativeWeek(runtime)
 const recoveries=[]
 for(const index of [0,1]){const response=await post(runtime,'/api/handset/recovery',{callRecordId:calls[index].recordId,dueAt:analyticsNow+3600000,maxAttempts:1},source.headers);assert.equal(response.status,201,await response.clone().text());recoveries.push((await response.json()).recovery)}
 const decline=await post(runtime,'/api/handset/recovery/'+recoveries[1].id+'/decline',{revision:1,note:'Customer declined'},source.headers);assert.equal(decline.status,200)
 return {source,calls,recoveries}
}

async function confirmedRecovery(runtime,source,calls,edges){
 const write=async(path,value,status=200,headers=source.headers)=>{
  const response=await post(runtime,path,value,headers)
  assert.equal(response.status,status,await response.clone().text());return response.json()
 }
 const recoveries=[]
 for(const call of calls)recoveries.push((await write('/api/handset/recovery',{callRecordId:call.recordId,dueAt:Date.now()+3600000,maxAttempts:1},201)).recovery)
 recoveries[0]=(await write('/api/handset/recovery/'+recoveries[0].id+'/decline',{revision:recoveries[0].revision,note:'Customer declined this need'})).recovery
 await write('/api/handset/receptionist/policy',{policy:policyFor('synthetic-handset-1'),expectedVersion:0,confirm:'set receptionist limits'},201)
 const issued=await write('/api/handset/mcp/consent',{name:'Known week recovery',definition:{scopes:['send'],tools:['outcome.work'],records:[calls[1].caseId],numbers:[],recipients:[],budgetCents:0,policyRevision:'owner-only-v1'},expiresAt:Date.now()+3600000,confirm:'approve scoped credential'},201)
 const agent=(path,value,status=200)=>write('/api/handset/application/receptionist/'+path,value,status,{authorization:'Bearer '+issued.token})
 const opened=await agent('outcomes',{callId:'synthetic-handset-2201',caseId:calls[1].caseId,language:'en',callerName:'Jordan Lee',callerEmail:'synthetic-handset-2202@example.test',identityBasis:'callback_to_number_on_file',identityVerified:true},201)
 const startAt='2026-11-02T16:00:00.000Z',prefix='outcomes/'+opened.outcome.id+'/'
 edges.slots.push(startAt)
 await agent(prefix+'availability',{serviceId:'furnace'})
 const booking=await agent(prefix+'booking',{serviceId:'furnace',startAt})
 assert.equal(booking.step.state,'confirmed')
 const external=edges.bookings.get(booking.step.externalId)
 assert.ok(external,'the receiving booking system independently retained the confirmed appointment')
 assert.deepEqual({state:external.state,startAt:external.startAt,email:external.email,callId:external.answers.handsetCall},{state:'confirmed',startAt,email:'synthetic-handset-2202@example.test',callId:'synthetic-handset-2201'})
 recoveries[1]=(await write('/api/handset/recovery/'+recoveries[1].id+'/resolve',{revision:recoveries[1].revision,outcomeId:opened.outcome.id})).recovery
 assert.equal(recoveries[1].state,'resolved')
 return {recoveries,booking,outcome:opened.outcome,externalBooking:external}
}

export async function knownWeekFixture(runtime,edges){
 await runtime.setTime(Date.parse('2026-11-01T06:15:00Z'))
 let recovery
 const {source,calls}=await nativeWeek(runtime,{
  beforeCall:at=>runtime.setTime(at),
  afterCall:async({source,calls,index})=>{
   if(index===4){
    source.cookie=(await signIn(runtime)).cookie;source.headers.cookie=source.cookie
    assert.equal(calls[4].caseId,calls[0].caseId)
    const response=await post(runtime,'/api/handset/recovery',{callRecordId:calls[4].recordId,dueAt:Date.now()+3600000,maxAttempts:1},source.headers)
    assert.equal(response.status,201,await response.clone().text())
    const repeated=(await response.json()).recovery
    assert.notEqual(repeated.id,recovery.recoveries[0].id)
    assert.equal(repeated.state,'open')
    recovery.recoveries.push(repeated)
   }
   if(index!==1)return
   await runtime.setTime(Date.parse('2026-11-01T07:20:00Z'))
   recovery=await confirmedRecovery(runtime,source,calls,edges)
  },
 })
 const recordingSid='synthetic-handset-2203'
 source.resource('Recordings',recordingSid,{call_sid:'synthetic-handset-analytics-2',status:'failed',start_time:'2026-11-02T15:01:00Z'})
 const failed=await source.callback({CallSid:'synthetic-handset-analytics-2',RecordingSid:recordingSid,RecordingStatus:'failed',From:'',To:''})
 assert.equal(failed.status,200,await failed.clone().text());const failedRecording=await failed.json()
 await runtime.setTime(analyticsNow)
 source.cookie=(await signIn(runtime)).cookie;source.headers.cookie=source.cookie
 const dataset=metricDataset(),shift=Date.parse('2026-11-02T15:00:00Z')-metricStart
 // Reviewed queue observations are a separate historical population. Their
 // call identities do not claim to be the signed carrier calls above.
 for(const entry of dataset.entries){
  for(const field of ['enteredAt','answeredAt','abandonedAt','closedAt'])if(entry[field]!==undefined)entry[field]+=shift
 }
 for(const segment of dataset.agents){segment.startAt+=shift;segment.endAt+=shift}
 const imported=await importDataset(runtime,source.cookie,dataset)
 return {source,calls,...recovery,dataset,imported,failedRecording}
}
