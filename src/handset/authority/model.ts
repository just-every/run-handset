import { object, keys, text, integer, timestamp, choice, Fault, type ObjectValue } from '../core'
export const tools=['case.read','comment.draft','recording.read','call.paid','message.send','campaign.launch','number.port','number.release','flow.publish','commitment.make'] as const
export type Tool=typeof tools[number]
export function list(value:unknown,name:string,max=100){
 if(!Array.isArray(value)||value.length>max)throw new Fault(`invalid_${name}`)
 const result=value.map(v=>text(v,name,200)).sort()
 if(new Set(result).size!==result.length)throw new Fault(`duplicate_${name}`)
 return result
}
export interface Definition { scopes:string[];tools:Tool[];records:string[];numbers:string[];recipients:string[];budgetCents:number;policyRevision:string }
export function definition(value:ObjectValue):Definition{
 keys(value,['scopes','tools','records','numbers','recipients','budgetCents','policyRevision'])
 const scopes=list(value.scopes,'scopes',3).map(v=>choice(v,['read','draft','send'],'scope'))
 const permittedTools=list(value.tools,'tools',10).map(v=>choice(v,tools,'tool'))
 if(!scopes.length||!permittedTools.length)throw new Fault('empty_grant')
 for(const tool of permittedTools)if(!scopes.includes(scopeFor(tool)))throw new Fault('tool_scope_mismatch')
 return {scopes,tools:permittedTools,records:list(value.records,'records'),numbers:list(value.numbers,'numbers'),recipients:list(value.recipients,'recipients'),budgetCents:integer(value.budgetCents,'budgetCents',0,10000000),policyRevision:text(value.policyRevision,'policyRevision',80)}
}
export const scopeFor=(tool:Tool)=>tool==='comment.draft'?'draft':['case.read','recording.read'].includes(tool)?'read':'send'
export interface State { operation:Tool;caseId:string;caseVersion:number;numberId:string;recipients:string[];amountCents:number;flowRevision:string;policyRevision:string;content:string }
export function state(value:unknown):State{
 const v=object(value);keys(v,['operation','caseId','caseVersion','numberId','recipients','amountCents','flowRevision','policyRevision','content'])
 return {operation:choice(v.operation,tools,'operation'),caseId:text(v.caseId,'caseId'),caseVersion:integer(v.caseVersion,'caseVersion',1),numberId:text(v.numberId??'','numberId',200,true),recipients:list(v.recipients??[],'recipients'),amountCents:integer(v.amountCents??0,'amountCents',0,10000000),flowRevision:text(v.flowRevision??'','flowRevision',100,true),policyRevision:text(v.policyRevision,'policyRevision',80),content:text(v.content??'','content',4000,true)}
}
export function expires(value:unknown){const expiry=timestamp(value,'expiresAt');if(expiry<=Date.now()||expiry>Date.now()+86400000)throw new Fault('expiry_must_be_within_one_day');return expiry}
export interface Bounds { numberId:string;recipients:string[];maxCents:number;maxListSize:number;flowRevision:string;policyRevision:string }
export function bounds(value:unknown):Bounds{
 const v=object(value);keys(v,['numberId','recipients','maxCents','maxListSize','flowRevision','policyRevision'])
 return {numberId:text(v.numberId,'numberId'),recipients:list(v.recipients,'recipients'),maxCents:integer(v.maxCents,'maxCents',0,10000000),maxListSize:integer(v.maxListSize,'maxListSize',1,100),flowRevision:text(v.flowRevision??'','flowRevision',100,true),policyRevision:text(v.policyRevision,'policyRevision',80)}
}
