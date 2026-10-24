import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { digest, Fault, id, keys, owner, type ObjectValue } from '../core'
import { activeSourceById, sourceFence } from '../providers/sources'
import { send } from '../receptionist/edge'

// A carrier amount is a price observation, never invoice reconciliation or a payment.
export async function readUsage(env:Bindings,actor:Session,recordId:string,value:ObjectValue){
 owner(actor);keys(value,['confirm'])
 if(value.confirm!=='read exact billed usage')throw new Fault('exact_usage_readback_required')
 const call=await env.DB.prepare(`SELECT r.id,r.kind,r.case_id,r.data,so.external_id,rs.source_id,(SELECT external_id FROM hnd_source_objects parent WHERE parent.record_id=r.parent_id LIMIT 1) AS parent_external FROM hnd_records r JOIN hnd_record_sources rs ON rs.record_id=r.id JOIN hnd_source_objects so ON so.record_id=r.id AND so.source_id=rs.source_id WHERE r.id=? AND r.kind IN ('call_session','call_leg','message','recording') AND rs.source_kind='twilio'`).bind(recordId).first<{id:string;kind:string;case_id:string;data:string;external_id:string;source_id:string;parent_external:string|null}>()
 if(!call)throw new Fault('verified_communication_required',404)
 const message=call.kind==='message',recording=call.kind==='recording',resource=message?'Messages':recording?'Recordings':'Calls'
 const source=await activeSourceById(env,call.source_id)
 if(!source)throw new Fault('source_inactive',409)
 const wire=await send(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(source.account_id)}/${resource}/${encodeURIComponent(call.external_id)}.json`,{method:'GET',headers:{authorization:'Basic '+btoa(source.account_id+':'+env.HANDSET_TWILIO_AUTH_TOKEN)}})
 if(!wire||wire.status!==200)throw new Fault('usage_readback_unavailable',503)
 const receipt=wire.body,original=JSON.parse(call.data)
 if(receipt.sid!==call.external_id||receipt.account_sid!==source.account_id||(recording?(!call.parent_external||receipt.call_sid!==call.parent_external):(receipt.from!==original.from||receipt.to!==original.to)))throw new Fault('usage_receipt_identity_mismatch',502)
 const final=message?['sent','delivered','undelivered','failed','received','read','canceled']:recording?['completed']:['completed','busy','failed','no-answer','canceled']
 if(!final.includes(String(receipt.status)))throw new Fault('communication_usage_not_final',409)
 if(typeof receipt.price!=='string'||! /^-?\d{1,7}(?:\.\d{1,6})?$/.test(receipt.price)||String(receipt.price_unit).toUpperCase()!=='USD')throw new Fault('usd_usage_not_available',503)
 const occurredAt=Date.parse(String(message?(receipt.date_sent??receipt.date_created):recording?(receipt.start_time??receipt.date_created):receipt.end_time)),providerUpdatedAt=Date.parse(String(receipt.date_updated))
 if(!Number.isFinite(occurredAt)||!Number.isFinite(providerUpdatedAt))throw new Fault('usage_provider_time_unavailable',503)
 const negative=receipt.price.startsWith('-'),[whole,fraction='']=receipt.price.replace('-','').split('.')
 const magnitude=Number(whole)*1000000+Number(fraction.padEnd(6,'0'))
 const units=message?String(receipt.num_segments):null
 if(message&&(!units||!/^\d{1,6}$/.test(units)))throw new Fault('message_usage_units_unavailable',503)
 if(recording&&(!/^\d{1,6}$/.test(String(receipt.duration))||! /^(1|2)$/.test(String(receipt.channels))))throw new Fault('recording_usage_units_unavailable',503)
 const data={...(recording?{providerResource:resource,durationSeconds:Number(receipt.duration),channels:Number(receipt.channels)}:{}),...(message?{providerResource:resource,segments:Number(units),mediaCount:JSON.parse(call.data).media?.length??0}:{}),providerPriceUsd:receipt.price,amountMicrousd:(negative?1:-1)*magnitude,currency:'USD',providerStatus:String(receipt.status),providerUpdatedAt,invoiceReconciled:false,customerOutcome:'unconfirmed'}
 const key='usage:'+call.external_id+':'+await digest({data,occurredAt}),now=Date.now()
 const existing=await env.DB.prepare('SELECT r.* FROM hnd_records r JOIN hnd_record_sources rs ON rs.record_id=r.id WHERE rs.source_id=? AND rs.source_event_id=?').bind(source.id,key).first<{id:string}>()
 if(existing){await commit(env,actor,'record.usage',existing.id,'completed',[sourceFence(env,source)],true,sourcePolicy(source));return {record:existing,replay:true,invoiceReconciled:false}}
 const latest=await env.DB.prepare("SELECT r.id,r.data FROM hnd_records r JOIN hnd_record_sources rs ON rs.record_id=r.id WHERE r.parent_id=? AND r.kind='usage' AND rs.source_id=? AND NOT EXISTS(SELECT 1 FROM hnd_records newer WHERE newer.supersedes_id=r.id) ORDER BY r.received_at DESC LIMIT 1").bind(call.id,source.id).first<{id:string;data:string}>()
 if(latest&&providerUpdatedAt<=JSON.parse(latest.data).providerUpdatedAt)throw new Fault('usage_observation_stale_or_conflicting',409)
 const record=id()
 await commit(env,actor,'record.usage',record,'completed',[sourceFence(env,source),
  env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT CASE WHEN COALESCE((SELECT r.id FROM hnd_records r JOIN hnd_record_sources rs ON rs.record_id=r.id WHERE r.parent_id=? AND r.kind='usage' AND rs.source_id=? AND NOT EXISTS(SELECT 1 FROM hnd_records newer WHERE newer.supersedes_id=r.id) ORDER BY r.received_at DESC LIMIT 1),'')=? THEN 1 ELSE 0 END").bind(call.id,source.id,latest?.id??''),
  env.DB.prepare('INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(record,'usage','native',source.id+':'+key,occurredAt,now,call.case_id,call.id,latest?.id??null,JSON.stringify(data),source.id),
  env.DB.prepare('INSERT INTO hnd_record_sources VALUES (?,?,?,?)').bind(record,source.id,'twilio',key),
 ],true,sourcePolicy(source))
 return {record:await env.DB.prepare('SELECT * FROM hnd_records WHERE id=?').bind(record).first(),replay:false,invoiceReconciled:false}
}
