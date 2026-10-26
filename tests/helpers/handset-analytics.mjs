import assert from 'node:assert/strict'
import { sourceFixture } from './handset-sources.mjs'
import { post } from './handset-auth.mjs'
export const analyticsStart=Date.parse('2026-11-01T00:00:00Z'),analyticsEnd=Date.parse('2026-11-08T00:00:00Z'),analyticsNow=analyticsEnd+12*3600000
export async function analyticsFixture(runtime){
 const source=await sourceFixture(runtime),calls=[]
 for(const [index,[at,status]] of [
  ['2026-11-01T06:15:00Z','no-answer'],['2026-11-01T07:15:00Z','failed'],['2026-11-02T15:00:00Z','completed'],['2026-11-03T16:00:00Z','busy'],['2026-11-04T17:00:00Z','no-answer'],['2026-11-05T18:00:00Z','canceled'],['2026-11-08T00:00:00Z','no-answer']
 ].entries()){
  const response=await source.callback({CallSid:'synthetic-handset-analytics-'+index,From:index===4?'+15125554000':'+1512555'+String(4000+index),CallStatus:status,SequenceNumber:'0',Timestamp:at});assert.equal(response.status,200,await response.clone().text());calls.push(await response.json())
 }
 const leg=await source.callback({CallSid:'synthetic-handset-analytics-leg',ParentCallSid:'synthetic-handset-analytics-2',CallStatus:'completed',SequenceNumber:'0',Timestamp:'2026-11-02T15:01:00Z'});assert.equal(leg.status,200,await leg.clone().text())
 const recoveries=[]
 for(const index of [0,1]){const response=await post(runtime,'/api/handset/recovery',{callRecordId:calls[index].recordId,dueAt:analyticsNow+3600000,maxAttempts:1},source.headers);assert.equal(response.status,201,await response.clone().text());recoveries.push((await response.json()).recovery)}
 const decline=await post(runtime,'/api/handset/recovery/'+recoveries[1].id+'/decline',{revision:1,note:'Customer declined'},source.headers);assert.equal(decline.status,200)
 return {source,calls,recoveries}
}
