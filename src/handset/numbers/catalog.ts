import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { choice, Fault, id, keys, text, type ObjectValue } from '../core'
import { accountReady, accountRoot, money, phone, readCarrier } from './provider'

export interface Quote {id:string;account_id:string;e164:string;country:string;kind:string;monthly_usd:string;capabilities:string;owner_id:string;owner_version:number;expires_at:number}
export async function searchNumbers(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['accountId','country','kind','areaCode','city','contains'])
 const account=text(v.accountId,'accountId',100),country=choice(v.country,['US','CA'],'country'),kind=choice(v.kind,['local','tollfree'],'kind')
 const area=text(v.areaCode??'','areaCode',3,true),city=text(v.city??'','city',80,true),contains=text(v.contains??'','contains',16,true)
 if(area&&!/^\d{3}$/.test(area))throw new Fault('invalid_areaCode')
 if(contains&&!/^[A-Za-z0-9*+]+$/.test(contains))throw new Fault('invalid_contains')
 await accountReady(env,account)
 const query=new URLSearchParams({PageSize:'20'});if(area)query.set('AreaCode',area);if(city)query.set('InLocality',city);if(contains)query.set('Contains',contains)
 const available=await readCarrier(env,account,`${accountRoot(account)}/AvailablePhoneNumbers/${country}/${kind==='local'?'Local':'TollFree'}.json?${query}`)
 const pricing=await readCarrier(env,account,`https://pricing.twilio.com/v1/PhoneNumbers/Countries/${country}`)
 if(pricing.iso_country!==country||String(pricing.price_unit).toUpperCase()!=='USD'||!Array.isArray(pricing.phone_number_prices))throw new Fault('carrier_usd_price_required',409)
 const price=pricing.phone_number_prices.find((p:Record<string,unknown>)=>p.number_type===(kind==='local'?'local':'toll free'))
 const monthly=money(price?.current_price)
 if(!Array.isArray(available.available_phone_numbers)||available.available_phone_numbers.length>20)throw new Fault('carrier_catalog_invalid',502)
 const quotes:Quote[]=available.available_phone_numbers.map((row:Record<string,unknown>)=>{
  const capabilities=row.capabilities as Record<string,unknown>
  if(row.iso_country!==country||!capabilities||typeof capabilities.voice!=='boolean'||typeof capabilities.SMS!=='boolean'||typeof capabilities.MMS!=='boolean')throw new Fault('carrier_capabilities_required',502)
  return {id:id(),account_id:account,e164:phone(row.phone_number),country,kind,monthly_usd:monthly,capabilities:JSON.stringify(capabilities),owner_id:actor.operator.id,owner_version:actor.operator.version,expires_at:Date.now()+300000}
 })
 await commit(env,actor,'number.search','installation','completed',quotes.map(q=>env.DB.prepare('INSERT INTO hnd_number_quotes VALUES (?,?,?,?,?,?,?,?,?,?)').bind(q.id,q.account_id,q.e164,q.country,q.kind,q.monthly_usd,q.capabilities,q.owner_id,q.owner_version,q.expires_at)))
 return {quotes,setupCost:'Not supplied by the carrier pricing API; review your carrier contract before approving purchase.',carrier:'Twilio',currency:'USD'}
}
