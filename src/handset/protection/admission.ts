import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { digest, Fault, id, integer, text } from '../core'
import { address, evaluateRules, type Admission, type Route, type Rule, type Verdict } from './model'
interface Attempt {id:string;decision:Verdict['decision'];reason:string;rule_id:string|null;attempted_cents:number;request_hash:string}
export async function nativeNumber(env:Bindings,numberId:string){
 const row=await env.DB.prepare("SELECT data FROM hnd_records WHERE id=? AND kind='number'").bind(numberId).first<{data:string}>()
 if(!row)throw new Fault('native_number_required',404)
 return JSON.parse(row.data).e164 as string
}
export const routeFor=(env:Bindings,numberId:string,sourceId?:string)=>sourceId?env.DB.prepare('SELECT * FROM hnd_protection_routes WHERE number_id=? AND source_id=?').bind(numberId,sourceId).first<Route>():env.DB.prepare('SELECT * FROM hnd_protection_routes WHERE number_id=? ORDER BY configured_at DESC,source_id LIMIT 1').bind(numberId).first<Route>()
/** Native admission gate, BEFORE a provider effect. A decision is never evidence
 * that a carrier accepted, delivered, charged, or that a human answered. */
export async function admitProtection(env:Bindings,input:Admission){
 const a={...input,address:address(input.address)},db=env.DB
 text(a.principal,'principal');text(a.deviceId,'deviceId',200);text(a.eventKey,'eventKey',200)
 await nativeNumber(env,a.numberId)
 const requestHash=await digest([a.numberId,a.deviceId,a.channel,a.direction,a.address,a.personalId??null,a.sourceId??null])
 const prior=await db.prepare('SELECT * FROM hnd_protection_attempts WHERE principal=? AND event_key=?').bind(a.principal,a.eventKey).first<Attempt>()
 if(prior&&prior.request_hash!==requestHash)throw new Fault('protection_event_conflict',409)
 const now=Date.now(),route=await routeFor(env,a.numberId,a.sourceId),attemptId=id()
 const outbound=a.direction!=='inbound'
 const cost=outbound?integer(a.attemptedCents??route?.attempt_cents??0,'attemptedCents',0,10000000):0
 let verdict:Verdict,contain=false
 const window=a.direction==='inbound'&&a.channel==='voice'?await db.prepare('SELECT number_id FROM hnd_protection_emergency_windows WHERE number_id=? AND expires_at>?').bind(a.numberId,now).first():null
 const callback=a.direction==='inbound'&&a.channel==='voice'?await db.prepare('SELECT id FROM hnd_protection_callbacks WHERE number_id=? AND caller=? AND expires_at>?').bind(a.numberId,a.address,now).first():null
 if(a.channel==='voice'&&a.direction==='outbound'&&a.address==='911')verdict={decision:'exempt',reason:'direct_emergency_call',emergency:true}
 else if(window)verdict={decision:'exempt',reason:'post_911_callback_window',emergency:true}
 else if(callback)verdict={decision:'exempt',reason:'designated_emergency_callback',emergency:true}
 else if(outbound){
  const stop=await db.prepare("SELECT reason FROM hnd_protection_stops WHERE number_id=? AND recipient=? AND channel IN (?, 'all') ORDER BY reason LIMIT 1").bind(a.numberId,a.address,a.channel).first<{reason:string}>()
  const contained=await db.prepare('SELECT id FROM hnd_protection_alerts WHERE number_id=? AND device_id=? AND channel=? AND containment=? AND released_at IS NULL').bind(a.numberId,a.deviceId,a.channel,'device_outbound_blocked').first()
  const count=await db.prepare('SELECT count(*) AS n FROM hnd_protection_attempts WHERE number_id=? AND device_id=? AND channel=? AND direction=? AND occurred_at>=? AND NOT (principal=? AND event_key=?)').bind(a.numberId,a.deviceId,a.channel,a.direction,now-(route?.window_seconds??60)*1000,a.principal,a.eventKey).first<{n:number}>()
  if(stop)verdict={decision:'block',reason:stop.reason}
  else if((count?.n??0)>=(route?.max_attempts??5)-1){verdict={decision:'block',reason:a.channel==='sms'?'sms_pumping_velocity':a.channel==='sip'?'sip_registration_velocity':'dial_velocity'};contain=true}
  else if(contained)verdict={decision:'block',reason:'device_contained'}
  else if(!a.authorized){verdict={decision:'block',reason:a.direction==='registration'?'unauthorized_registration':a.channel==='sms'?'unauthorized_message':a.address.startsWith('+')&&!a.address.startsWith('+1')?'unauthorized_international_call':'unauthorized_outbound'};contain=true}
  else if(!a.consent)verdict={decision:'block',reason:'current_consent_required'}
  else verdict={decision:'held',reason:'provider_adapter_unqualified'}
 }else{
  const rules=(await db.prepare('SELECT * FROM hnd_protection_rules WHERE revoked_at IS NULL').all<Rule>()).results
  verdict=evaluateRules(rules,a)
 }
 if(prior){
  await append(env,a.principal,'protection.admit',prior.id,['block','screen','held'].includes(verdict.decision)?'refused':'completed',a.fences??[])
  return {id:prior.id,...verdict,attemptedCents:prior.attempted_cents,originalDecision:prior.decision,replay:true,effectOccurred:false}
 }
 const statements=[...(a.fences??[]),db.prepare(`INSERT INTO hnd_protection_attempts
 (id,principal,event_key,request_hash,number_id,device_id,channel,direction,address,attempted_cents,decision,reason,rule_id,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(attemptId,a.principal,a.eventKey,requestHash,a.numberId,a.deviceId,a.channel,a.direction,a.address,cost,verdict.decision,verdict.reason,verdict.ruleId??null,now)]
 if(verdict.reason==='direct_emergency_call'){
  const setting=await db.prepare('SELECT minutes FROM hnd_protection_emergency_settings WHERE number_id=?').bind(a.numberId).first<{minutes:number}>()
  const until=now+Math.max(60,setting?.minutes??60)*60000
  statements.push(db.prepare('INSERT INTO hnd_protection_emergency_windows VALUES (?,?,?,?) ON CONFLICT(number_id) DO UPDATE SET opened_at=excluded.opened_at,expires_at=max(expires_at,excluded.expires_at),attempt_id=excluded.attempt_id').bind(a.numberId,now,until,attemptId))
 }
 if(contain)statements.push(db.prepare(`INSERT INTO hnd_protection_alerts
 (id,number_id,device_id,channel,reason,containment,attempt_id,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(number_id,device_id,channel,reason) DO NOTHING`).bind(id(),a.numberId,a.deviceId,a.channel,verdict.reason,'device_outbound_blocked',attemptId,now))
 await append(env,a.principal,contain?'protection.contain':'protection.admit',attemptId,['block','screen','held'].includes(verdict.decision)?'refused':'completed',statements)
 return {id:attemptId,...verdict,attemptedCents:cost,costBasis:'configured upper bound; not a carrier charge',replay:false,effectOccurred:false}
}
