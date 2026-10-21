import { choice, Fault, integer, keys, object, text, timestamp, type ObjectValue } from '../core'
export const modes=['preview','progressive','power','parallel','predictive'] as const
export type Mode=typeof modes[number]
export interface Qualification {id:string;source_id:string;number_sid:string;definition:string;approved_by:string;owner_version:number;created_at:number;expires_at:number;revoked_at:number|null}
export interface QualificationDefinition {legalReviewer:string;legalEvidenceId:string;providerReviewer:string;providerEvidenceId:string;trafficEvidenceId:string;jurisdictions:string[];modes:Mode[];disclosure:string;abandonMessage:string;maxAbandonBps:number;maxConnectMs:number;ringSeconds:number;reportWindowDays:number;minimumSamples:number;maxConcurrency:number;inboundReserve:number;breachSeconds:number}
export interface List {id:string;name:string;purpose:string;source_id:string;queue_id:string;qualification_id:string;definition:string;snapshot_hash:string;approved_by:string;owner_version:number;policy_id:string|null;policy_revision:number|null;created_at:number;expires_at:number;revoked_at:number|null;reserved_cents:number}
export interface ListDefinition {repId:string;budgetCents:number;attemptCents:number;maxConcurrency:number;from:string;modes:Mode[]}
export interface Recipient {list_id:string;ordinal:number;case_id:string;person_id:string;recipient:string;definition:string}
export interface RecipientDefinition {timezone:string;jurisdiction:string;startMinute:number;endMinute:number;consentId:string}
export interface RecipientCheck {consentEvidenceId:string;company:string;national:string;state:string;campaign:string;purpose:string;methods:string[]}
export interface Run {id:string;list_id:string;mode:Mode;state:'running'|'paused'|'completed';reason:string;cursor:number;created_by:string;created_at:number;revision:number}
export interface Attempt {id:string;session_id:string;list_id:string;ordinal:number;mode:Mode;event_key:string;state:string;reason:string;agent_id:string|null;account_id:string;from_number:string;recipient:string;conference_sid:string|null;conference_name:string|null;agent_call_sid:string|null;provider_sid:string|null;created_at:number;observed_at:number|null;answer_at:number|null;ended_at:number|null;bridge_emitted_at:number|null;bridge_observed_at:number|null;disposition:string;version:number}
export interface Ready {agent_id:string;source_id:string;conference_sid:string;conference_name:string;agent_call_sid:string;approved_by:string;owner_version:number;observed_at:number;expires_at:number}
export function listOf(value:unknown,name:string,max=100){if(!Array.isArray(value)||!value.length||value.length>max)throw new Fault('invalid_'+name);const a=value.map(v=>text(v,name));if(new Set(a).size!==a.length)throw new Fault('duplicate_'+name);return a}
export const modeList=(value:unknown)=>listOf(value,'modes',5).map(v=>choice(v,modes,'mode'))
export function expiry(value:unknown,max=86400000){const at=timestamp(value,'expiresAt');if(at<=Date.now()||at>Date.now()+max)throw new Fault('expiry_out_of_bounds');return at}
export function phone(value:unknown){const v=text(value,'recipient',20);if(!/^\+1\d{10}$/.test(v))throw new Fault('us_recipient_required');return v}
export function recipientInput(value:unknown){
 const v=object(value);keys(v,['caseId','personId','recipient','timezone','jurisdiction','startMinute','endMinute','consentId'])
 const timezone=text(v.timezone,'timezone');try{new Intl.DateTimeFormat('en-US',{timeZone:timezone})}catch{throw new Fault('unknown_caller_timezone')}
 if(!timezone.startsWith('America/')&&!['Pacific/Honolulu'].includes(timezone))throw new Fault('unqualified_caller_timezone')
 const jurisdiction=text(v.jurisdiction,'jurisdiction',10);if(!/^US-[A-Z]{2}$/.test(jurisdiction))throw new Fault('unknown_jurisdiction')
 const startMinute=integer(v.startMinute,'startMinute',480,1259),endMinute=integer(v.endMinute,'endMinute',481,1260)
 if(endMinute<=startMinute)throw new Fault('invalid_calling_window')
 return {caseId:text(v.caseId,'caseId'),personId:text(v.personId,'personId'),recipient:phone(v.recipient),definition:{timezone,jurisdiction,startMinute,endMinute,consentId:text(v.consentId,'consentId')} satisfies RecipientDefinition}
}
export function qualificationInput(v:ObjectValue):QualificationDefinition{
 keys(v,['sourceId','numberSid','legalReviewer','legalEvidenceId','providerReviewer','providerEvidenceId','trafficEvidenceId','jurisdictions','modes','disclosure','abandonMessage','maxAbandonBps','maxConnectMs','ringSeconds','reportWindowDays','minimumSamples','maxConcurrency','inboundReserve','breachSeconds','expiresAt','confirm'])
 if(v.confirm!=='record independently qualified policy and permitted traffic')throw new Fault('qualification_evidence_required',403)
 return {legalReviewer:text(v.legalReviewer,'legalReviewer'),legalEvidenceId:text(v.legalEvidenceId,'legalEvidenceId'),providerReviewer:text(v.providerReviewer,'providerReviewer'),providerEvidenceId:text(v.providerEvidenceId,'providerEvidenceId'),trafficEvidenceId:text(v.trafficEvidenceId,'trafficEvidenceId'),jurisdictions:listOf(v.jurisdictions,'jurisdictions',60),modes:modeList(v.modes),disclosure:text(v.disclosure,'disclosure',1000),abandonMessage:text(v.abandonMessage,'abandonMessage',1000),maxAbandonBps:integer(v.maxAbandonBps,'maxAbandonBps',0,300),maxConnectMs:integer(v.maxConnectMs,'maxConnectMs',1,2000),ringSeconds:integer(v.ringSeconds,'ringSeconds',15,60),reportWindowDays:integer(v.reportWindowDays,'reportWindowDays',1,30),minimumSamples:integer(v.minimumSamples,'minimumSamples',1,10000),maxConcurrency:integer(v.maxConcurrency,'maxConcurrency',1,10),inboundReserve:integer(v.inboundReserve,'inboundReserve',1,100),breachSeconds:integer(v.breachSeconds,'breachSeconds',1,120)}
}
