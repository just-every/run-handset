import { choice, Fault, integer, keys, text, type ObjectValue } from '../core'
import { modes } from './model'
import { nativeOptions } from './read'
import type { Context } from './storage'

const selected=(v:ObjectValue,prefix:string)=>Object.entries(v).filter(([k])=>k.startsWith(prefix+'.')).map(([k,value])=>{if(value!=='selected')throw new Fault('invalid_form_selection');return k.slice(prefix.length+1)})
const modeFields=modes.map(m=>'mode.'+m)
function strict(v:ObjectValue,names:string[],prefixes:string[]=[]) {
 keys(v,[...names,...modeFields,...Object.keys(v).filter(k=>prefixes.some(p=>k.startsWith(p+'.')&&/^[a-zA-Z0-9_-]+$/.test(k.slice(p.length+1))))])
}
function numeric(value:unknown,name:string) {
 if(typeof value!=='string'||!/^\d+$/.test(value))throw new Fault('invalid_'+name)
 return integer(Number(value),name)
}
function date(value:unknown,name:string) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))throw new Fault('invalid_'+name)
 const n=Date.parse(value+'Z')
 if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,value.length)!==value)throw new Fault('invalid_'+name)
 return n
}
function minute(value:unknown,name:string) {
 if(typeof value!=='string'||!/^\d{2}:\d{2}$/.test(value))throw new Fault('invalid_'+name)
 const [h,m]=value.split(':').map(Number)
 if(h>23||m>59)throw new Fault('invalid_'+name)
 return h*60+m
}
// Only HTML uses named controls. JSON API bodies retain their existing schema.
export async function mapDialerForm(ctx:Context,path:string,v:ObjectValue):Promise<ObjectValue> {
 if(path==='/qualifications'){
  const names=['sourceId','numberSid','legalReviewer','legalEvidenceId','providerReviewer','providerEvidenceId','trafficEvidenceId','jurisdictions','disclosure','abandonMessage','maxAbandonBps','maxConnectMs','ringSeconds','reportWindowDays','minimumSamples','maxConcurrency','inboundReserve','breachSeconds','expiresAt','confirm']
  strict(v,names)
  const result:ObjectValue={...v,modes:selected(v,'mode'),jurisdictions:text(v.jurisdictions,'jurisdictions',1000).split(',').map(s=>s.trim()),expiresAt:date(v.expiresAt,'expiresAt')}
  for(const name of ['maxAbandonBps','maxConnectMs','ringSeconds','reportWindowDays','minimumSamples','maxConcurrency','inboundReserve','breachSeconds'])result[name]=numeric(v[name],name)
  for(const name of modeFields)delete result[name]
  return result
 }
 if(path==='/policies'){
  strict(v,['purpose','maxListSize','maxBudgetCents','attemptCents','startsAt','expiresAt','confirm'],['rep','source'])
  return {repIds:selected(v,'rep'),sourceIds:selected(v,'source'),modes:selected(v,'mode'),purpose:v.purpose,maxListSize:numeric(v.maxListSize,'maxListSize'),maxBudgetCents:numeric(v.maxBudgetCents,'maxBudgetCents'),attemptCents:numeric(v.attemptCents,'attemptCents'),startsAt:date(v.startsAt,'startsAt'),expiresAt:date(v.expiresAt,'expiresAt'),confirm:v.confirm}
 }
 if(path==='/lists'){
  const count=integer(numeric(v.recipientCount,'recipientCount'),'recipientCount',1,100)
  const recipientFields=Array.from({length:count},(_,i)=>['consentId','recipient','timezone','jurisdiction','startTime','endTime'].map(k=>`recipient.${i}.${k}`)).flat()
  strict(v,['recipientCount','name','purpose','sourceId','queueId','qualificationId','repId','budgetCents','attemptCents','maxConcurrency','approvalScope','policyId','expiresAt','confirm',...recipientFields])
  if(v.confirm!=='approve exact audience under selected authority')throw new Fault('exact_list_approval_required',403)
  const approvalScope=choice(v.approvalScope,['exact','standing'],'approvalScope')
  if(approvalScope==='exact'&&v.policyId)throw new Fault('exact_scope_cannot_select_standing_policy')
  if(approvalScope==='standing'&&!v.policyId)throw new Fault('standing_policy_required')
  const options=await nativeOptions(ctx),recipients=Array.from({length:count},(_,i)=>{
   const get=(k:string)=>v[`recipient.${i}.${k}`],consentId=text(get('consentId'),'consentId'),c=options.consents.find(c=>c.id===consentId)
   if(!c)throw new Fault('current_native_recipient_selection_required',409)
   return {caseId:c.case_id,personId:c.person_id,consentId,recipient:get('recipient'),timezone:get('timezone'),jurisdiction:get('jurisdiction'),startMinute:minute(get('startTime'),'startTime'),endMinute:minute(get('endTime'),'endTime')}
  })
  return {name:v.name,purpose:v.purpose,sourceId:v.sourceId,queueId:v.queueId,qualificationId:v.qualificationId,repId:v.repId,budgetCents:numeric(v.budgetCents,'budgetCents'),attemptCents:numeric(v.attemptCents,'attemptCents'),maxConcurrency:numeric(v.maxConcurrency,'maxConcurrency'),modes:selected(v,'mode'),recipients,...(approvalScope==='standing'?{policyId:v.policyId}:{}),expiresAt:date(v.expiresAt,'expiresAt'),confirm:approvalScope==='standing'?'snapshot list under exact standing policy':'approve exact campaign list and budget'}
 }
 if(/^\/lists\/[^/]+\/recipients\/[0-9]+\/verify$/.test(path)){
  strict(v,['consentEvidenceId','company','national','state','campaign','purpose','expiresAt','confirm'])
  return {consentEvidenceId:v.consentEvidenceId,company:v.company,national:v.national,state:v.state,campaign:v.campaign,purpose:v.purpose,methods:selected(v,'mode'),expiresAt:date(v.expiresAt,'expiresAt'),confirm:v.confirm}
 }
 if(path==='/ready'){
  keys(v,['agentId','sourceId','conferenceSid','conferenceName','agentCallSid','expiresAt','confirm'])
  return {...v,expiresAt:date(v.expiresAt,'expiresAt')}
 }
 return v
}
