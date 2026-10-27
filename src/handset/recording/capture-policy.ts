import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { choice, Fault, id, text, type ObjectValue } from '../core'
import { guard, sql } from '../delegation/store'
import { activeSourceById, sourceFence } from '../providers/sources'

export interface Participant {id:string;consent:'yes'|'no'|'unknown'}
export interface Capture {id:string;call_id:string;source_id:string;source_revision:number;account_id:string;call_sid:string;created_by:string;owner_version:number;revision:number;state:string;jurisdiction:string;participants:string;announced_revision:number|null;recording_sid:string|null;retain_until:number|null;hold:number;created_at:number}
export function participantPolicy(v:ObjectValue){
 const jurisdiction=choice(v.jurisdiction,['all-party','unknown'],'jurisdiction')
 if(!Array.isArray(v.participants)||v.participants.length<2||v.participants.length>32)throw new Fault('exact_participants_required')
 const participants=v.participants.map(value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Fault('invalid_participant')
  const p=value as ObjectValue
  if(Object.keys(p).some(k=>!['id','consent'].includes(k)))throw new Fault('invalid_participant')
  return {id:text(p.id,'participantId',100),consent:choice(p.consent,['yes','no','unknown'],'consent')}
 })
 if(new Set(participants.map(p=>p.id)).size!==participants.length)throw new Fault('distinct_participants_required')
 return {jurisdiction,participants:JSON.stringify(participants),state:jurisdiction==='all-party'&&participants.every(p=>p.consent==='yes')?'ready':'blocked'}
}
export async function capture(env:Bindings,target:string){
 const row=await sql(env,'SELECT * FROM hnd_capture_sessions WHERE id=?',target).first<Capture>()
 if(!row)throw new Fault('capture_not_found',404)
 return row
}
export const captureFence=(env:Bindings,r:Capture)=>guard(env,'SELECT count(*) FROM hnd_capture_sessions WHERE id=? AND revision=? AND state=?',r.id,r.revision,r.state)
export async function currentCapture(env:Bindings,r:Capture){
 const source=await activeSourceById(env,r.source_id)
 if(!source||source.revision!==r.source_revision)throw new Fault('capture_source_unavailable',403)
 return source
}
export async function writeCapture(env:Bindings,actor:Session,r:Capture,kind:string,changes:Partial<Capture>,extra:D1PreparedStatement[]=[]){
 const entries=Object.entries(changes)
 await commit(env,actor,'recording.capture',r.id,changes.state==='uncertain'||changes.state==='erasing'?'uncertain':'completed',[
  captureFence(env,r),...extra,
  sql(env,`UPDATE hnd_capture_sessions SET ${entries.map(([key])=>key+'=?').join(',')},revision=revision+1 WHERE id=?`,...entries.map(([,v])=>v as string|number|null),r.id),
  sql(env,'INSERT INTO hnd_capture_boundaries VALUES (?,?,?,?)',r.id,r.revision+1,kind,Date.now()),
 ])
 return capture(env,r.id)
}
export async function createCapture(env:Bindings,actor:Session,v:ObjectValue){
 if(v.confirm!=='review exact call participants')throw new Fault('participant_review_required',403)
 const callId=text(v.callId,'callId'),policy=participantPolicy(v)
 const linked=await sql(env,`SELECT o.external_id,s.id AS source_id FROM hnd_records r JOIN hnd_source_objects o ON o.record_id=r.id JOIN hnd_sources s ON s.id=o.source_id WHERE r.id=? AND r.kind IN ('call_session','call_leg') ORDER BY s.revision DESC LIMIT 1`,callId).first<{external_id:string;source_id:string}>()
 const source=linked?await activeSourceById(env,linked.source_id):null
 if(!source||!linked)throw new Fault('current_call_source_required',409)
 const target=id()
 await commit(env,actor,'recording.capture',target,'completed',[
  sourceFence(env,source),
  guard(env,"SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_capture_sessions WHERE call_id=? AND state IN ('ready','capturing','paused','uncertain','erasing')) THEN 0 ELSE 1 END",callId),
  sql(env,'INSERT INTO hnd_capture_sessions VALUES (?,?,?,?,?,?,?,?,1,?,?,?,NULL,NULL,NULL,0,?)',target,callId,source.id,source.revision,source.account_id,linked.external_id,actor.operator.id,actor.operator.version,policy.state,policy.jurisdiction,policy.participants,Date.now()),
  sql(env,'INSERT INTO hnd_capture_boundaries VALUES (?,1,?,?)',target,'participants',Date.now()),
 ])
 return capture(env,target)
}
// Only recordings started by these controls acquire these extra restrictions.
// Existing owner-attested playback and independent text grants remain required.
const restricted=`SELECT 1 FROM hnd_capture_sessions c JOIN hnd_records r ON r.id=? WHERE c.call_id=r.parent_id AND (c.recording_sid=json_extract(r.data,'$.recordingSid') OR (c.recording_sid IS NULL AND c.state='uncertain')) AND (c.state!='stopped' OR c.jurisdiction!='all-party' OR EXISTS(SELECT 1 FROM json_each(c.participants) p WHERE json_extract(p.value,'$.consent')!='yes') OR (c.retain_until IS NOT NULL AND c.retain_until<=?) OR NOT EXISTS(SELECT 1 FROM oa_operators o WHERE o.id=c.created_by AND o.version=c.owner_version AND o.role='owner' AND o.status='active'))`
export const captureContentFence=(env:Bindings,recordingId:string)=>guard(env,`SELECT CASE WHEN EXISTS(${restricted}) THEN 0 ELSE 1 END`,recordingId,Date.now())
export async function captureContentAccess(env:Bindings,recordingId:string){
 if(await sql(env,restricted,recordingId,Date.now()).first())throw new Fault('capture_content_withheld',403)
 return captureContentFence(env,recordingId)
}
