import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, choice, field, hidden, id, integer, json, keys, owner, consolePage, escape as e, text, type ObjectValue } from '../core'
import { activeSourceById, sourceFence } from '../providers/sources'
import { transcriptDoor } from '../transcripts/doors'
import { capturePermission, carePrompt, getCall, getPolicy, guard, policyAuthority, type ConsentPolicy } from './store'

async function configure(env:Bindings,actor:Session,v:ObjectValue) {
 keys(v,['sourceId','businessName','legalConfiguration','registrationId','staffTarget','expiresAt','confirm'])
 if(v.confirm!=='approve exact informational consent policy')throw new Fault('reviewed_legal_configuration_required',403)
 const source=await activeSourceById(env,text(v.sourceId,'sourceId'))
 if(!source)throw new Fault('consent_source_inactive',409)
 const staff=text(v.staffTarget,'staffTarget',30)
 if(!/^\+[1-9]\d{7,14}$/.test(staff)||staff===source.e164||/^\+1(?:911|988)/.test(staff))throw new Fault('approved_staff_number_required')
 const latest=await env.DB.prepare('SELECT max(revision) AS revision FROM hnd_consent_policies WHERE source_id=?').bind(source.id).first<{revision:number|null}>(),key=id(),now=Date.now()
 await commit(env,actor,'consent.configure',key,'completed',[sourceFence(env,source),env.DB.prepare('INSERT INTO hnd_consent_policies VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)').bind(key,source.id,(latest?.revision??0)+1,text(v.businessName,'businessName',100),text(v.legalConfiguration,'legalConfiguration',3000),text(v.registrationId,'registrationId'),staff,actor.operator.id,actor.operator.version,now,integer(v.expiresAt,'expiresAt',now+1000,now+86400000))])
 const policy=await getPolicy(env,key)
 return {policy,prompt:carePrompt(policy),providerPath:'/providers/twilio/consent/'+source.id}
}
async function verbal(env:Bindings,actor:Session,v:ObjectValue) {
 keys(v,['callId','transcriptId','segmentId','recordingPermissionId','confirm'])
 if(v.confirm!=='I heard explicit permission for one customer-care text about this call')throw new Fault('human_verbal_attestation_required',403)
 const call=await getCall(env,text(v.callId,'callId')),policy=await getPolicy(env,call.policy_id),{source,fences}=await policyAuthority(env,policy)
 const permissionId=text(v.recordingPermissionId,'recordingPermissionId'),transcriptId=text(v.transcriptId,'transcriptId'),segmentId=text(v.segmentId,'segmentId')
 const recordingConsent=await env.DB.prepare("SELECT p.* FROM hnd_verbal_recording_permissions p JOIN oa_operators o ON o.id=p.approved_by WHERE p.id=? AND p.call_id=? AND p.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=p.owner_version").bind(permissionId,call.id).first<{id:string;created_at:number}>()
 if(!recordingConsent)throw new Fault('separate_recording_permission_required',403)
 const url=new URL('/api/handset/transcripts/'+encodeURIComponent(transcriptId),env.AUTH_ORIGIN)
 const response=await transcriptDoor(new Request(url),env,actor)
 const transcript=await response!.json() as {sourceId:string;callId:string;recordedAt:number;segments:{id:string;text:string;startMs:number;endMs:number}[]}
 const native=await env.DB.prepare('SELECT record_id FROM hnd_source_objects WHERE source_id=? AND external_id=?').bind(source.id,call.call_sid).first<{record_id:string}>()
 const moment=transcript.segments.find(s=>s.id===segmentId)
 if(!moment||transcript.sourceId!==source.id||transcript.callId!==native?.record_id||recordingConsent.created_at>transcript.recordedAt)throw new Fault('permitted_same_call_transcript_moment_required',403)
 await commit(env,actor,'consent.verbal',call.id,'completed',[...fences,guard(env,"SELECT count(*) FROM hnd_verbal_recording_permissions p JOIN oa_operators o ON o.id=p.approved_by WHERE p.id=? AND p.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=p.owner_version",permissionId)])
 const permission=await capturePermission(env,call,'one_reply','granted',carePrompt(policy),{kind:'human_verbal',personId:actor.operator.id,transcriptId,segmentId,moment,recordingPermissionId:permissionId,serverTimestamp:Date.now()})
 return {permission,marketingEnrollment:false}
}
async function report(env:Bindings,actor:Session) {
 await commit(env,actor,'consent.read','installation','completed')
 const [policies,calls,permissions,texts,outcomes]=await Promise.all(['hnd_consent_policies','hnd_consent_calls','hnd_text_permissions','hnd_care_texts','hnd_consent_outcomes'].map(table=>env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 200`).all()))
 return {policies:policies.results,calls:calls.results,permissions:permissions.results,texts:texts.results,outcomes:outcomes.results,bounded:true,marketingEnrollment:false}
}
export async function consentDoor(request:Request,env:Bindings,actor:Session,v?:ObjectValue):Promise<Response> {
 owner(actor)
 const path=new URL(request.url).pathname,native=path.startsWith('/app/consent'),base=native?'/app/consent':'/api/handset/consent'
 if(new URL(request.url).search)throw new Fault('unexpected_consent_query')
 if(request.method==='GET'&&path===base) {
  const result=await report(env,actor)
  if(!native)return json(result)
  return consolePage('Call text consent',`<p>One optional customer-care reply for a missed call. Survey permission is requested separately. <a href="/app/surveys">Post-call surveys</a></p><h2>Consent evidence</h2><ul>${result.permissions.map(r=>`<li>${e(r.purpose)} · ${e(r.state)} · ${e(new Date(Number(r.created_at)).toISOString())}<details><summary>Inspect permission</summary><p>${e(r.prompt)}</p><pre>${e(JSON.stringify(JSON.parse(String(r.event)),null,2))}</pre></details></li>`).join('')||'<li>No permissions recorded.</li>'}</ul><h2>Missed calls</h2><ul>${result.outcomes.map(r=>`<li>${e(r.reason)} · <a href="/app/recovery">Owned callback work</a></li>`).join('')||'<li>No missed-call outcomes.</li>'}</ul><h2>Texts</h2><ul>${result.texts.map(r=>`<li>${e(r.state)} · ${e(r.reason)}</li>`).join('')||'<li>No texts requested.</li>'}</ul><details><summary>Settings: reviewed consent policy</summary><p>Approve the exact business, legal configuration, toll-free verification and staff number. Missing recipient timezone or pending verification holds texts. Staff ringing continues after either choice.</p><form method="post" action="/app/consent/policies">${field('Source ID','sourceId')}${field('Business name','businessName')}${field('Reviewed customer-care and survey legal configuration','legalConfiguration')}${field('Toll-free verification ID','registrationId')}${field('Approved staff phone number','staffTarget')}${field('Approval expires (UTC)','expiresAt','','datetime-local')}${hidden('confirm','approve exact informational consent policy')}<button>Approve exact consent policy</button></form><h3>Current policies</h3><ul>${result.policies.map(r=>`<li>${e(r.business_name)} · Revision ${e(r.revision)} · ${r.revoked_at?'Revoked':'Expires '+e(new Date(Number(r.expires_at)).toISOString())}<p>Voice provider path: <code>/providers/twilio/consent/${e(r.source_id)}</code></p><form method="post" action="/app/consent/revoke">${hidden('policyId',r.id)}<button>Revoke policy</button></form></li>`).join('')||'<li>No reviewed policies.</li>'}</ul></details><details><summary>Settings: recipient local hours</summary><form method="post" action="/app/consent/recipients">${field('Recipient E.164','recipient')}${field('Verified IANA timezone','timezone')}${field('Allowed start minute after midnight','startMinute','480','number')}${field('Allowed end minute after midnight','endMinute','1260','number')}${field('Review expires (UTC)','expiresAt','','datetime-local')}${hidden('confirm','approve recipient timezone and hours')}<button>Approve recipient local hours</button></form></details>`)
 }
 if(request.method!=='POST'||!v)throw new Fault('method_not_allowed',405)
 let result:unknown
 if(native){v={...v};if(typeof v.expiresAt==='string')v.expiresAt=Date.parse(v.expiresAt+'Z');for(const key of ['startMinute','endMinute'])if(typeof v[key]==='string')v[key]=Number(v[key])}
 if(path===base+'/policies')result=await configure(env,actor,v)
 else if(path===base+'/recording-permissions') {
  keys(v,['callId','evidence','confirm'])
  if(v.confirm!=='I verified participant permission before this recording')throw new Fault('separate_recording_permission_required',403)
  const call=await getCall(env,text(v.callId,'callId')),{fences}=await policyAuthority(env,await getPolicy(env,call.policy_id)),permissionId=id()
  await commit(env,actor,'consent.recording',permissionId,'completed',[...fences,env.DB.prepare('INSERT INTO hnd_verbal_recording_permissions VALUES (?,?,?,?,?,?,NULL)').bind(permissionId,call.id,text(v.evidence,'evidence',3000),actor.operator.id,actor.operator.version,Date.now())])
  result={id:permissionId,scope:'owner attestation for one existing call; no automatic recording'}
 } else if(path===base+'/verbal')result=await verbal(env,actor,v)
 else if(path===base+'/recipients') {
  keys(v,['recipient','timezone','startMinute','endMinute','expiresAt','confirm'])
  if(v.confirm!=='approve recipient timezone and hours')throw new Fault('explicit_recipient_review_required',403)
  const recipient=text(v.recipient,'recipient'),timezone=text(v.timezone,'timezone')
  if(!/^\+[1-9]\d{7,14}$/.test(recipient))throw new Fault('invalid_recipient')
  try{new Intl.DateTimeFormat('en-US',{timeZone:timezone})}catch{throw new Fault('invalid_timezone')}
  const start=integer(v.startMinute,'startMinute',480,1259),end=integer(v.endMinute,'endMinute',start+1,1260),expires=integer(v.expiresAt,'expiresAt',Date.now()+1000,Date.now()+86400000)
  await commit(env,actor,'consent.recipient','installation','completed',[env.DB.prepare('INSERT INTO hnd_text_recipients VALUES (?,?,?,?,?,?,?) ON CONFLICT(recipient) DO UPDATE SET timezone=excluded.timezone,start_minute=excluded.start_minute,end_minute=excluded.end_minute,approved_by=excluded.approved_by,owner_version=excluded.owner_version,expires_at=excluded.expires_at').bind(recipient,timezone,start,end,actor.operator.id,actor.operator.version,expires)])
  result={reviewed:true}
 } else if(path===base+'/revoke') {
  keys(v,['policyId']);const policy=await getPolicy(env,text(v.policyId,'policyId'))
  await commit(env,actor,'consent.revoke',policy.id,'completed',[env.DB.prepare('UPDATE hnd_consent_policies SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(Date.now(),policy.id)])
  result={revoked:true}
 } else throw new Fault('not_found',404)
 return native?consolePage('Consent settings recorded','<p role="status">Exact reviewed settings recorded.</p><a href="/app/consent">Review call text consent</a>'):json(result,201)
}
