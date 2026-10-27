import type { Bindings } from '../../auth.server'
import { Fault, id } from '../core'
import { guard, sql } from '../delegation/store'

interface Call {id:string;kind:string;parent_id:string|null;case_id:string;occurred_at:number}
interface Need {id:string;case_id:string;state:string;revision:number;updated_at:number}
/** One verified inbound call stays attached to its original need. Only a newly
 * occurring call can start separate work after a terminal human decision. */
export async function recoveryNeed(env:Bindings,caseId:string,recordId:string) {
 let key=recordId,call:Call|null=null
 for(let depth=0;depth<12;depth++) {
  call=await sql(env,'SELECT id,kind,parent_id,case_id,occurred_at FROM hnd_records WHERE id=?',key).first<Call>()
  if(!call||call.case_id!==caseId)throw new Fault('verified_call_case_required',409)
  if(call.kind==='call_session')break
  if(!call.parent_id)throw new Fault('verified_parent_required',409)
  key=call.parent_id
 }
 if(call?.kind!=='call_session')throw new Fault('verified_parent_required',409)
 const mapped=await sql(env,'SELECT r.* FROM hnd_recovery_calls c JOIN hnd_recovery r ON r.id=c.recovery_id WHERE c.call_id=?',call.id).first<Need>()
 if(mapped)return {id:mapped.id,existing:mapped,fences:[] as D1PreparedStatement[],mapping:[] as D1PreparedStatement[]}
 const latest=await sql(env,'SELECT * FROM hnd_recovery WHERE case_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',caseId).first<Need>()
 const historical=await sql(env,"SELECT * FROM hnd_recovery WHERE case_id=? AND state IN ('resolved','declined','stopped') AND updated_at>=? ORDER BY updated_at,rowid LIMIT 1",caseId,call.occurred_at).first<Need>()
 const existing=historical??(latest&&!['resolved','declined','stopped'].includes(latest.state)?latest:null)
 const needId=existing?.id??id()
 return {id:needId,existing,fences:[
  ...(latest?[guard(env,'SELECT count(*) FROM hnd_recovery WHERE id=? AND revision=?',latest.id,latest.revision)]:[guard(env,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_recovery WHERE case_id=?) THEN 0 ELSE 1 END',caseId)]),
  guard(env,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_recovery_calls WHERE call_id=?) THEN 0 ELSE 1 END',call.id),
 ],mapping:[sql(env,'INSERT INTO hnd_recovery_calls VALUES (?,?)',call.id,needId)]}
}
