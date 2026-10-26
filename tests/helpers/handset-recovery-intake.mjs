import assert from 'node:assert/strict'
import { openHandset } from './handset-worker.mjs'
import { sourceFixture } from './handset-sources.mjs'
import { post } from './handset-auth.mjs'

export const intakeTime=Date.parse('2026-10-26T18:00:00Z')
export const intakeHours={weekly:[{days:[1],startMinute:540,endMinute:1020}]}
export function intakeCall(runtime,source,n,{caller=`+1512555${String(3100+n)}`,status='no-answer'}={}) {
 const sid=`synthetic-handset-intake-${n}`,url=`https://api.twilio.com/2010-04-01/Accounts/${source.account}/Calls/${sid}.json`
 const business='+15125550125'
 source.resource('Calls',sid,{parent_call_sid:null,direction:'inbound',from:caller,to:business,status,date_created:new Date(Date.now()-60000).toUTCString(),start_time:null,end_time:new Date().toUTCString(),duration:'0'})
 const resource=runtime.twilioResources.get(url),children={calls:[],next_page_uri:null}
 runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${source.account}/Calls.json?ParentCallSid=${sid}&PageSize=100`,children)
 const fields={CallSid:sid,From:caller,To:business,CallStatus:status,SequenceNumber:'0',Timestamp:new Date().toISOString()}
 return {sid,url,caller,resource,children,fields,send:(extra={},options={})=>source.callback({...fields,...extra},options)}
}
export async function intakeFixture() {
 const runtime=await openHandset({twilio:true,clockTime:intakeTime})
 try {
  const source=await sourceFixture(runtime),base='/api/handset/recovery'
  async function write(path,value,status=201,headers=source.headers) {const response=await post(runtime,path,value,headers);assert.equal(response.status,status,await response.clone().text());return response.json()}
  async function get(path=base) {const response=await runtime.request(path,{headers:source.headers});assert.equal(response.status,200,await response.clone().text());return response.json()}
  const approve=(revision=0,extra={})=>write(base+'/policies',{sourceId:source.source.id,revision,timezone:'America\u002fChicago',hours:intakeHours,confirm:'approve owned missed-call intake',...extra})
  return {runtime,source,base,write,get,approve,call:(n,extra)=>intakeCall(runtime,source,n,extra)}
 }catch(error){await runtime.close();throw error}
}
