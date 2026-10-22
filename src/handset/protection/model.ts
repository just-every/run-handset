import { choice, Fault, text, type ObjectValue, keys } from '../core'
export type Channel='voice'|'fax'|'sms'|'sip'
export type Decision='allow'|'block'|'screen'|'exempt'|'held'
export interface Rule {id:string;scope:'owner'|'personal';personal_id:string|null;number_id:string|null;channel:'voice'|'fax'|'all';match_kind:'number'|'prefix'|'anonymous';pattern:string;effect:'allow'|'block'|'screen';created_by:string;created_at:number;revoked_at:number|null}
export interface Route {source_id:string;number_id:string;personal_id:string|null;continuation_url:string;emergency_url:string;max_attempts:number;window_seconds:number;attempt_cents:number;revision:number}
/** Only authenticated adapters supply authority/consent. Caller instructions never do. */
export interface Admission {principal:string;eventKey:string;numberId:string;deviceId:string;channel:Channel;direction:'inbound'|'outbound'|'registration';address:string;personalId?:string;sourceId?:string;authorized?:boolean;consent?:boolean;attemptedCents?:number;fences?:D1PreparedStatement[]}
export interface Verdict {decision:Decision;reason:string;ruleId?:string;emergency?:boolean}
export const e164=(value:unknown,name='address')=>{const v=text(value,name,16);if(!/^\+[1-9]\d{7,14}$/.test(v))throw new Fault('invalid_'+name);return v}
export const address=(value:unknown)=>{const v=text(value,'address',200);if(v==='911'||['anonymous','unknown','restricted','unavailable'].includes(v.toLowerCase()))return v.toLowerCase();return e164(v)}
export const anonymous=(value:string)=>['anonymous','unknown','restricted','unavailable'].includes(value)
export function ruleInput(v:ObjectValue){
 keys(v,['scope','personalId','numberId','channel','matchKind','pattern','effect','confirm'])
 if(v.confirm!=='apply nuisance policy')throw new Fault('explicit_protection_consent_required')
 const scope=choice(v.scope,['owner','personal'],'scope'),matchKind=choice(v.matchKind,['number','prefix','anonymous'],'matchKind')
 let pattern=matchKind==='anonymous'?'':text(v.pattern,'pattern',16)
 if(matchKind==='number')pattern=e164(pattern,'pattern')
 if(matchKind==='prefix'&&!/^\+[1-9]\d{0,13}$/.test(pattern))throw new Fault('invalid_prefix')
 const personalId=scope==='personal'?text(v.personalId,'personalId'):null
 if(scope==='owner'&&v.personalId)throw new Fault('owner_rule_has_no_personal_scope')
 return {scope,personalId,numberId:v.numberId?text(v.numberId,'numberId'):null,channel:choice(v.channel,['voice','fax','all'],'channel'),matchKind,pattern,effect:choice(v.effect,['allow','block','screen'],'effect')}
}
/** Emergency callbacks decide first. Owner restrictions bind everyone; owner
 * allows lift only owner restrictions. Specificity wins before equal-match ties. */
export function evaluateRules(rules:Rule[],a:Admission):Verdict{
 const matching=rules.filter(r=>!r.revoked_at&&(!r.number_id||r.number_id===a.numberId)&&(r.scope==='owner'||r.personal_id===a.personalId)&&(r.channel==='all'||r.channel===a.channel)&&
  (r.match_kind==='anonymous'?anonymous(a.address):r.match_kind==='number'?r.pattern===a.address:a.address.startsWith(r.pattern)))
 const order=(r:Rule)=>[r.match_kind==='number'?3:r.match_kind==='prefix'?2:1,r.pattern.length,r.effect==='allow'?2:r.effect==='block'?1:0]
 const pick=(scope:string)=>matching.filter(r=>r.scope===scope).sort((a,b)=>{const x=order(a),y=order(b);for(let n=0;n<x.length;n++)if(x[n]!==y[n])return y[n]-x[n];return a.id.localeCompare(b.id)})[0]
 const owner=pick('owner'),personal=pick('personal'),r=owner&&owner.effect!=='allow'?owner:personal??owner
 return r?{decision:r.effect,reason:r.effect==='allow'?'allow_exception':r.effect==='block'?'nuisance_rule':'screening_digit_required',ruleId:r.id}:{decision:'allow',reason:'no_nuisance_match'}
}
