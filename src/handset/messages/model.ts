import { Fault, integer, keys, object, text } from '../core'
export interface Thread {route_kind:string;participants:string;id:string;source_id:string;business:string;peer:string;owner_id:string|null;revision:number;custody:'handset'|'happytohelp';updated_at:number}
export interface InboxMessage {id:string;thread_id:string;provider_sid:string;direction:string;body:string;media:string;participants:string;provider_state:string;carrier_state:string;occurred_at:number}
export interface Media {url:string;mime:string;bytes:number}
export interface MessageJob {id:string;thread_id:string;permission_id:string;snippet_id:string;body:string;media:string;due_at:number;state:string;reason:string;provider_state:string;carrier_state:string;provider_sid:string|null;revision:number;created_by:string;owner_version:number;thread_revision:number;policy_id:string|null;approved_at:number|null;created_at:number;submitted_at:number|null;readback_at:number|null}
export const phone=(value:unknown)=>{const p=text(value,'recipient',30);if(!/^\+[1-9]\d{7,14}$/.test(p))throw new Fault('invalid_recipient');return p}
const gsm=/^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà\^{}\\\[~\]|€]*$/
export function segments(body:string) {
 const unicode=!gsm.test(body),units=unicode?body.length:[...body].reduce((n,c)=>n+(/[\^{}\\\[~\]|€]/.test(c)?2:1),0)
 return {encoding:unicode?'UCS-2':'GSM-7',segments:units<= (unicode?70:160)?1:Math.ceil(units/(unicode?67:153))}
}
export function messageBody(value:unknown) {const body=text(value,'body',1600);if(segments(body).segments>10)throw new Fault('route_segment_limit');return body}
export function mediaList(value:unknown):Media[] {
 if(value===undefined)return []
 if(!Array.isArray(value)||value.length>10)throw new Fault('route_media_limit')
 const result=value.map(raw=>{const m=object(raw);keys(m,['url','mime','bytes']);const url=text(m.url,'mediaUrl',500),mime=text(m.mime,'mime',60),bytes=integer(m.bytes,'bytes',1,5000000)
  if(!/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/[^/?#]+\/Messages\/[^/?#]+\/Media\/[^/?#]+$/.test(url)||!['image/jpeg','image/png','image/gif'].includes(mime))throw new Fault('route_media_type_or_address')
  return {url,mime,bytes}
 })
 if(result.reduce((n,m)=>n+m.bytes,0)>5000000)throw new Fault('route_media_size_limit')
 return result
}
export const route=(sourceId:string,business:string)=>({source_id:sourceId,business,sms:true,mms:true,group:false,maxMedia:10,maxMediaBytes:5000000,maxSegments:10,groupReason:'Twilio Programmable Messaging is one-to-one; group delivery requires a separately qualified Conversations route'})
