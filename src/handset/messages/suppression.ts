import type { Bindings } from '../../auth.server'
import { Fault } from '../core'
import { guard } from '../consent/store'
export const stopQuery="SELECT count(*) FROM hnd_protection_stops WHERE recipient=? AND (channel IN ('sms','all') OR reason='dnc')"
export const noStopFence=(env:Bindings,recipient:string)=>guard(env,'SELECT CASE WHEN ('+stopQuery+')=0 THEN 1 ELSE 0 END',recipient)
export async function suppression(env:Bindings,recipient:string) {
 const suppressed=Number(await env.DB.prepare(stopQuery).bind(recipient).first<number>('count(*)'))>0
 return {suppressed,scope:'all company numbers and current native sends',requiredReplyPolicy:'provider-managed-only',marketingEnrollment:false}
}
export async function requireNoStop(env:Bindings,recipients:string[]) {
 for(const recipient of recipients)if((await suppression(env,recipient)).suppressed)throw new Fault('recipient_STOP_or_DNC',409)
}
// Existing application recipients are opaque person records. Use the selected
// case's native communication parties, never treat a person ID as a phone.
export const caseStopQuery=`SELECT count(*) FROM hnd_protection_stops s WHERE (s.channel IN ('sms','all') OR s.reason='dnc') AND EXISTS(SELECT 1 FROM hnd_records r WHERE r.case_id=? AND r.source='native' AND s.recipient IN (json_extract(r.data,'$.from'),json_extract(r.data,'$.to')))`
export const noCaseStopFence=(env:Bindings,caseId:string)=>guard(env,'SELECT CASE WHEN ('+caseStopQuery+')=0 THEN 1 ELSE 0 END',caseId)
export async function caseSuppression(env:Bindings,caseId:string) {
 return {suppressed:Number(await env.DB.prepare(caseStopQuery).bind(caseId).first<number>('count(*)'))>0,scope:'selected native case parties across all company numbers',requiredReplyPolicy:'provider-managed-only',sendAuthorized:false}
}
export async function requireCaseNoStop(env:Bindings,caseId:string) {
 if((await caseSuppression(env,caseId)).suppressed)throw new Fault('recipient_STOP_or_DNC',409)
}
