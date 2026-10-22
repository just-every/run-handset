import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, id, integer, keys, text, timestamp, choice, type ObjectValue } from '../core'
import { e164, ruleInput, type Route } from './model'
import { nativeNumber } from './admission'
async function personal(env:Bindings,operatorId:string|null){if(operatorId&&!await env.DB.prepare("SELECT id FROM oa_operators WHERE id=? AND status='active'").bind(operatorId).first())throw new Fault('active_person_required')}
export async function addRule(env:Bindings,actor:Session,v:ObjectValue){
 const r=ruleInput(v),ruleId=id()
 if(r.numberId)await nativeNumber(env,r.numberId)
 await personal(env,r.personalId)
 await commit(env,actor,'protection.rule',ruleId,'completed',[env.DB.prepare('INSERT INTO hnd_protection_rules VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(ruleId,r.scope,r.personalId,r.numberId,r.channel,r.matchKind,r.pattern,r.effect,actor.operator.id,Date.now(),null)])
 return {id:ruleId,...r}
}
export async function revokeRule(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['ruleId']);const ruleId=text(v.ruleId,'ruleId')
 if(!await env.DB.prepare('SELECT id FROM hnd_protection_rules WHERE id=?').bind(ruleId).first())throw new Fault('rule_not_found',404)
 await commit(env,actor,'protection.revoke',ruleId,'completed',[env.DB.prepare('UPDATE hnd_protection_rules SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(Date.now(),ruleId)])
 return {revoked:true}
}
function continuation(value:unknown,name:string){
 const raw=text(value??'',name,2000,true);if(!raw)return ''
 let url:URL;try{url=new URL(raw)}catch{throw new Fault('invalid_'+name)}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname==='/providers/twilio/protection')throw new Fault('invalid_'+name)
 return url.href
}
export async function configure(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['sourceId','personalId','continuationUrl','emergencyUrl','maxAttempts','windowSeconds','attemptCents','revision','confirm'])
 if(v.confirm!=='approve existing inbound continuation')throw new Fault('explicit_route_consent_required')
 const sourceId=text(v.sourceId,'sourceId'),source=await env.DB.prepare(`SELECT s.* FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id WHERE s.id=? AND s.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=s.owner_version`).bind(sourceId).first<{number_id:string;revision:number}>()
 if(!source)throw new Fault('active_source_required')
 const personalId=v.personalId?text(v.personalId,'personalId'):null;await personal(env,personalId)
 const current=await env.DB.prepare('SELECT * FROM hnd_protection_routes WHERE source_id=?').bind(sourceId).first<Route>()
 if(current&&integer(v.revision,'revision',1)!==current.revision)throw new Fault('route_revision_conflict',409)
 const url=continuation(v.continuationUrl,'continuationUrl'),emergency=continuation(v.emergencyUrl,'emergencyUrl'),revision=(current?.revision??0)+1
 const max=integer(v.maxAttempts,'maxAttempts',1,100),window=integer(v.windowSeconds,'windowSeconds',10,3600),cost=integer(v.attemptCents,'attemptCents',0,100000)
 const statements=[env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_sources WHERE id=? AND revision=? AND revoked_at IS NULL').bind(sourceId,source.revision)]
 if(current)statements.push(env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_protection_routes WHERE source_id=? AND revision=?').bind(sourceId,current.revision))
 statements.push(env.DB.prepare(`INSERT INTO hnd_protection_routes VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET personal_id=excluded.personal_id,continuation_url=excluded.continuation_url,emergency_url=excluded.emergency_url,max_attempts=excluded.max_attempts,window_seconds=excluded.window_seconds,attempt_cents=excluded.attempt_cents,configured_by=excluded.configured_by,revision=excluded.revision,configured_at=excluded.configured_at`).bind(sourceId,source.number_id,personalId,url,emergency,max,window,cost,actor.operator.id,revision,Date.now()))
 await commit(env,actor,'protection.configure',sourceId,'completed',statements)
 return {sourceId,revision,callbackPath:'/providers/twilio/protection',providerConfigurationChanged:false,outboundStatus:'held_adapter_unqualified'}
}
export async function designateCallback(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['numberId','caller','expiresAt','confirm']);if(v.confirm!=='designate emergency callback')throw new Fault('explicit_callback_designation_required')
 const numberId=text(v.numberId,'numberId'),caller=e164(v.caller,'caller'),expiresAt=timestamp(v.expiresAt,'expiresAt'),callbackId=id()
 if(expiresAt<=Date.now())throw new Fault('callback_review_date_required')
 await nativeNumber(env,numberId)
 await commit(env,actor,'protection.configure',callbackId,'completed',[env.DB.prepare('INSERT INTO hnd_protection_callbacks VALUES (?,?,?,?,?,?)').bind(callbackId,numberId,caller,expiresAt,actor.operator.id,Date.now())])
 return {id:callbackId,caller,expiresAt,designation:'owner designated; not provider verified'}
}
export async function addStop(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['numberId','recipient','channel','reason','confirm']);if(v.confirm!=='record outbound consent stop')throw new Fault('explicit_stop_required')
 const numberId=text(v.numberId,'numberId'),recipient=e164(v.recipient,'recipient'),channel=choice(v.channel,['voice','fax','sms','all'],'channel'),reason=choice(v.reason,['dnc','consent_revoked'],'reason'),stopId=id()
 await nativeNumber(env,numberId)
 await commit(env,actor,'protection.configure',stopId,'completed',[env.DB.prepare('INSERT INTO hnd_protection_stops VALUES (?,?,?,?,?,?,?) ON CONFLICT(number_id,recipient,channel,reason) DO NOTHING').bind(stopId,numberId,recipient,channel,reason,actor.operator.id,Date.now())])
 return {recorded:true,numberId,recipient,channel,reason}
}
export async function alertAction(env:Bindings,actor:Session,v:ObjectValue,release=false){
 keys(v,release?['alertId','confirm']:['alertId'])
 if(release&&v.confirm!=='release device containment')throw new Fault('explicit_release_required')
 const alertId=text(v.alertId,'alertId')
 if(!await env.DB.prepare('SELECT id FROM hnd_protection_alerts WHERE id=?').bind(alertId).first())throw new Fault('alert_not_found',404)
 await commit(env,actor,'protection.alert',alertId,'completed',[env.DB.prepare(release?'UPDATE hnd_protection_alerts SET released_at=COALESCE(released_at,?),released_by=COALESCE(released_by,?) WHERE id=?':'UPDATE hnd_protection_alerts SET acknowledged_at=COALESCE(acknowledged_at,?),acknowledged_by=COALESCE(acknowledged_by,?) WHERE id=?').bind(Date.now(),actor.operator.id,alertId)])
 return release?{released:true}:{acknowledged:true,containmentStillActive:true}
}

export async function callbackWindow(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['numberId','minutes','confirm']);if(v.confirm!=='set post-911 callback window')throw new Fault('explicit_callback_window_required',403)
 const numberId=text(v.numberId,'numberId'),minutes=integer(v.minutes,'minutes',60,Math.floor((8640000000000000-Date.now())/60000))
 await nativeNumber(env,numberId)
 await commit(env,actor,'protection.configure',numberId,'completed',[env.DB.prepare('INSERT INTO hnd_protection_emergency_settings VALUES (?,?,?,?) ON CONFLICT(number_id) DO UPDATE SET minutes=excluded.minutes,configured_by=excluded.configured_by,configured_at=excluded.configured_at').bind(numberId,minutes,actor.operator.id,Date.now())])
 return {numberId,minutes}
}
