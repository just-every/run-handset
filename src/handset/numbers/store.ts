import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, id, keys, text, type ObjectValue } from '../core'
import { accountReady, accountRoot, carrier, readCarrier } from './provider'
import type { Quote } from './catalog'

export interface Inventory {owner_name?:string;release_name?:string;id:string;request_key:string;quote_id:string;account_id:string;e164:string;provider_id:string|null;owner_id:string;owner_version:number;assignment:string;purpose:string;campaign:string;state:string;revision:number;created_at:number;replacement_id:string|null;replacement_revision:number|null;release_by:string|null;release_owner_version:number|null;release_revision:number|null;hold_until:number|null;released_at:number|null;emergency_state:string}
export const sql=(env:Bindings,q:string,...args:(string|number|null)[])=>env.DB.prepare(q).bind(...args)
export const guard=(env:Bindings,q:string,...args:(string|number|null)[])=>sql(env,'INSERT INTO hnd_guard(ok) '+q,...args)
export const inventoryFence=(env:Bindings,n:Inventory)=>guard(env,'SELECT count(*) FROM hnd_number_inventory WHERE id=? AND revision=? AND state=?',n.id,n.revision,n.state)
export async function getNumber(env:Bindings,key:string){const row=await sql(env,'SELECT * FROM hnd_number_inventory WHERE id=?',key).first<Inventory>();if(!row)throw new Fault('number_not_found',404);return row}
export async function listNumbers(env:Bindings){return (await env.DB.prepare('SELECT i.*,p.display_name AS owner_name,a.display_name AS release_name FROM hnd_number_inventory i JOIN oa_operators p ON p.id=i.owner_id LEFT JOIN oa_operators a ON a.id=i.release_by ORDER BY i.created_at DESC,i.id LIMIT 200').all<Inventory>()).results}
export async function purchase(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['quoteId','requestKey','assignment','purpose','campaign','confirm'])
 if(v.confirm!=='approve exact number and carrier charges under my direct contract')throw new Fault('exact_purchase_approval_required')
 const quoteId=text(v.quoteId,'quoteId'),requestKey=text(v.requestKey,'requestKey'),assignment=text(v.assignment,'assignment'),purpose=text(v.purpose,'purpose'),campaign=text(v.campaign??'','campaign',200,true)
 const prior=await sql(env,'SELECT * FROM hnd_number_inventory WHERE request_key=?',requestKey).first<Inventory>()
 if(prior){if(prior.quote_id!==quoteId||prior.assignment!==assignment||prior.purpose!==purpose||prior.campaign!==campaign)throw new Fault('purchase_request_conflict',409);return {number:prior,replay:true}}
 const quote=await sql(env,'SELECT * FROM hnd_number_quotes WHERE id=?',quoteId).first<Quote>()
 if(!quote||quote.expires_at<=Date.now()||quote.owner_id!==actor.operator.id||quote.owner_version!==actor.operator.version)throw new Fault('fresh_exact_owner_quote_required',409)
 await accountReady(env,quote.account_id)
 const pricing=await readCarrier(env,quote.account_id,`https://pricing.twilio.com/v1/PhoneNumbers/Countries/${quote.country}`)
 const prices=pricing.phone_number_prices
 if(pricing.iso_country!==quote.country||String(pricing.price_unit).toUpperCase()!=='USD'||!Array.isArray(prices)||!prices.some(p=>p.number_type===(quote.kind==='local'?'local':'toll free')&&p.current_price===quote.monthly_usd))throw new Fault('carrier_price_changed_search_again',409)
 const key=id(),now=Date.now()
 try{await commit(env,actor,'number.purchase',key,'uncertain',[
  guard(env,'SELECT count(*) FROM hnd_number_quotes WHERE id=? AND owner_id=? AND owner_version=? AND expires_at>?',quote.id,actor.operator.id,actor.operator.version,now),
  sql(env,"INSERT INTO hnd_number_inventory(id,request_key,quote_id,account_id,e164,owner_id,owner_version,assignment,purpose,campaign,state,revision,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'purchasing',1,?)",key,requestKey,quote.id,quote.account_id,quote.e164,actor.operator.id,actor.operator.version,assignment,purpose,campaign,now),
 ])}catch(error){
  if(String(error).includes('UNIQUE constraint')){
   const concurrent=await sql(env,'SELECT * FROM hnd_number_inventory WHERE request_key=?',requestKey).first<Inventory>()
   if(concurrent&&concurrent.quote_id===quoteId&&concurrent.assignment===assignment&&concurrent.purpose===purpose&&concurrent.campaign===campaign)return {number:concurrent,replay:true}
   throw new Fault('number_or_request_already_reserved',409)
  }throw error
 }
 // Persist intent before the first paid request. No later request retries it.
 let providerId:string|null=null
 try{
  const response=await carrier(env,quote.account_id,accountRoot(quote.account_id)+'/IncomingPhoneNumbers.json','POST',new URLSearchParams({PhoneNumber:quote.e164,FriendlyName:'Handset '+key}))
  if(response.status!==201)throw new Fault('carrier_purchase_not_confirmed',503)
  const receipt=await response.json() as Record<string,unknown>
  if(receipt.account_sid!==quote.account_id||receipt.phone_number!==quote.e164||typeof receipt.sid!=='string'||!receipt.sid)throw new Fault('carrier_purchase_identity_mismatch',502)
  const readback=await readCarrier(env,quote.account_id,`${accountRoot(quote.account_id)}/IncomingPhoneNumbers/${encodeURIComponent(receipt.sid)}.json`)
  if(readback.sid!==receipt.sid||readback.account_sid!==quote.account_id||readback.phone_number!==quote.e164||readback.friendly_name!=='Handset '+key)throw new Fault('carrier_purchase_readback_mismatch',502)
  providerId=receipt.sid
 }catch{
  await commit(env,actor,'number.purchase',key,'uncertain',[sql(env,"UPDATE hnd_number_inventory SET state='uncertain',revision=revision+1 WHERE id=? AND state='purchasing'",key)],false)
  return {number:await getNumber(env,key),replay:false}
 }
 await commit(env,actor,'number.purchase',key,'completed',[sql(env,"UPDATE hnd_number_inventory SET state='owned',provider_id=?,revision=revision+1 WHERE id=? AND state='purchasing'",providerId,key)],false)
 return {number:await getNumber(env,key),replay:false}
}
export async function reconcilePurchase(env:Bindings,actor:Session,n:Inventory){
 if(!['purchasing','uncertain'].includes(n.state))throw new Fault('uncertain_purchase_required',409)
 const result=await readCarrier(env,n.account_id,accountRoot(n.account_id)+'/IncomingPhoneNumbers.json?'+new URLSearchParams({PhoneNumber:n.e164,PageSize:'2'}))
 const rows=result.incoming_phone_numbers
 if(!Array.isArray(rows)||rows.length!==1||rows[0].account_sid!==n.account_id||rows[0].phone_number!==n.e164||rows[0].friendly_name!=='Handset '+n.id||typeof rows[0].sid!=='string')throw new Fault('exact_purchase_readback_required',409)
 await commit(env,actor,'number.reconcile',n.id,'completed',[inventoryFence(env,n),sql(env,"UPDATE hnd_number_inventory SET state='owned',provider_id=?,revision=revision+1 WHERE id=?",rows[0].sid,n.id)])
 return getNumber(env,n.id)
}
