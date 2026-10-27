import type { Bindings } from '../../auth.server'
import { Fault, text } from '../core'

export const accountRoot=(account:string)=>`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}`
export async function carrier(env:Bindings,account:string,url:string,method='GET',body?:URLSearchParams){
 if(!env.HANDSET_TWILIO_AUTH_TOKEN)throw new Fault('twilio_secret_binding_required',409)
 try{return await fetch(url,{method,headers:{authorization:'Basic '+btoa(account+':'+env.HANDSET_TWILIO_AUTH_TOKEN),...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},...(body?{body:body.toString()}:{}),redirect:'manual',signal:AbortSignal.timeout(5000)})}
 catch{throw new Fault('carrier_outcome_unknown',503)}
}
export async function readCarrier(env:Bindings,account:string,url:string){
 const response=await carrier(env,account,url)
 if(response.status!==200)throw new Fault('carrier_readback_unavailable',503)
 try{return await response.json() as Record<string,unknown>}catch{throw new Fault('carrier_readback_invalid',502)}
}
export async function accountReady(env:Bindings,account:string){
 const current=await readCarrier(env,account,accountRoot(account)+'.json')
 if(current.sid!==account||current.status!=='active'||current.type!=='Full')throw new Fault('active_full_carrier_account_required',409)
}
export const phone=(value:unknown)=>{const result=text(value,'phone',20);if(!/^\+1\d{10}$/.test(result))throw new Fault('north_american_number_required');return result}
export function money(value:unknown){
 if(typeof value!=='string'||!/^\d{1,5}(?:\.\d{1,6})?$/.test(value)||Number(value)<=0)throw new Fault('carrier_usd_price_required',409)
 return value
}
