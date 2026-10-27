import type { Bindings } from '../../auth.server'
import { callUrl, readTwilio } from '../consent/store'
import { Fault, text } from '../core'
import type { Source } from '../providers/sources'

const terminal=['completed','no-answer','busy','failed','canceled']
export async function answeredStaff(env:Bindings, source:Source, sid:string, caller:string, business:string, requiredSid?:string) {
 const list=await readTwilio(env,source,`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(source.account_id)}/Calls.json?ParentCallSid=${encodeURIComponent(sid)}&PageSize=100`)
 if(!Array.isArray(list.calls)||list.calls.length>100||list.next_page_uri)throw new Fault('recovery_staff_readback_incomplete',409)
 const identities=list.calls.map(raw=>text((raw as Record<string,unknown>).sid,'childSid'))
 if(new Set(identities).size!==identities.length||requiredSid&&!identities.includes(requiredSid))throw new Fault('recovery_staff_readback_incomplete',409)
 let answered=false
 // Re-read each child independently. A failed offer while the caller is still
 // waiting, a live child or an unknown duration never proves an unanswered call.
 for(let start=0;start<list.calls.length;start+=4) {
  const children=await Promise.all(list.calls.slice(start,start+4).map(async raw=>{
   const child=raw as Record<string,unknown>
   if(child.account_sid!==source.account_id||child.parent_call_sid!==sid)throw new Fault('recovery_child_identity_mismatch',502)
   const readback=await readTwilio(env,source,callUrl(source,text(child.sid,'childSid')))
   if(readback.sid!==child.sid)throw new Fault('recovery_child_identity_mismatch',502)
   return readback
  }))
  for(const child of children) {
   if(child.account_sid!==source.account_id||child.parent_call_sid!==sid||child.direction!=='outbound-dial'||![caller,business].includes(String(child.from)))throw new Fault('recovery_child_identity_mismatch',502)
   if(!terminal.includes(String(child.status)))throw new Fault('recovery_staff_outcome_uncertain',409)
   if(child.status==='completed') {
    if(!/^\d+$/.test(String(child.duration)))throw new Fault('recovery_staff_duration_required',409)
    if(Number(child.duration)>0)answered=true
   }
  }
 }
 return answered
}
