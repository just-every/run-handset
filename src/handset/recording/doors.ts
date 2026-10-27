import { captureContentAccess, captureContentFence } from './capture-policy'
import { captureDoor } from './capture-doors'
import { capturePage } from './capture-pages'
import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { actorRef, append, commit } from '../audit/store'
import type { AppliedPolicy } from '../audit/policy'
import { Fault, id, integer, json, keys, owner, text, consolePage, escape as e, field, type ObjectValue } from '../core'
import { guard, nativeFence, sql } from '../delegation/store'
import { sourceFence as currentSourceFence } from '../providers/sources'

// A later provider status appends to the original recording identity.
const completedRecording=`COALESCE((SELECT json_extract(status.data,'$.providerStatus') FROM hnd_records status WHERE status.parent_id=r.id AND status.kind='provider_attempt' AND json_extract(status.data,'$.objectKind')='recording' AND EXISTS(SELECT 1 FROM hnd_record_sources proof WHERE proof.record_id=status.id AND proof.source_kind='twilio') ORDER BY status.received_at DESC,status.id DESC LIMIT 1),json_extract(r.data,'$.providerStatus'))='completed'`
interface Recording {id:string;source_id:string;source_revision:number;external_id:string;account_id:string;source_owner:string;source_owner_version:number;parent_external:string}
async function recording(env:Bindings,target:string){
 const row=await sql(env,`SELECT r.id,rs.source_id,s.revision AS source_revision,so.external_id,s.account_id,s.owner_id AS source_owner,s.owner_version AS source_owner_version,parent.external_id AS parent_external FROM hnd_records r JOIN hnd_record_sources rs ON rs.record_id=r.id JOIN hnd_sources s ON s.id=rs.source_id JOIN hnd_source_objects so ON so.record_id=r.id AND so.source_id=s.id JOIN hnd_source_objects parent ON parent.record_id=r.parent_id AND parent.source_id=s.id JOIN oa_operators o ON o.id=s.owner_id JOIN hnd_records n ON n.id=s.number_id WHERE r.id=? AND r.kind='recording' AND ${completedRecording} AND s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=s.owner_version AND NOT EXISTS(SELECT 1 FROM hnd_records correction WHERE correction.supersedes_id=n.id) AND NOT EXISTS(SELECT 1 FROM hnd_sources newer WHERE newer.account_id=s.account_id AND newer.number_id=s.number_id AND newer.revision>s.revision)`,target).first<Recording>()
 if(!row)throw new Fault('recording_unavailable',404)
 return row
}
const sourceFence=(env:Bindings,r:Recording)=>currentSourceFence(env,{id:r.source_id,revision:r.source_revision})
const recordingFence=(env:Bindings,r:Recording)=>guard(env,`SELECT count(*) FROM hnd_records r WHERE r.id=? AND ${completedRecording}`,r.id)
interface Grant {id:string;recording_id:string;person_id:string;person_version:number;created_by:string;owner_version:number;expires_at:number;revoked_at:number|null}
const grantFence=(env:Bindings,actor:Session,g:Grant)=>guard(env,`SELECT count(*) FROM hnd_recording_grants g JOIN oa_operators o ON o.id=g.created_by JOIN oa_operators p ON p.id=g.person_id WHERE g.id=? AND g.person_id=? AND g.owner_version=? AND g.person_version=? AND g.revoked_at IS NULL AND g.expires_at>? AND p.status='active' AND p.version=g.person_version AND o.role='owner' AND o.status='active' AND o.version=g.owner_version`,g.id,actor.operator.id,g.owner_version,g.person_version,Date.now())
const playbackPolicy=(actor:Session,g?:Pick<Grant,'id'|'owner_version'>,r?:Recording):AppliedPolicy=>({native:{role:actor.operator.role,version:actor.operator.version},...(g?{recording:{id:g.id,revision:1,ownerVersion:g.owner_version}}:{}),...(r?{source:{id:r.source_id,revision:r.source_revision,ownerVersion:r.source_owner_version}}:{})})
async function currentGrant(env:Bindings,actor:Session,recordingId:string){
 return await sql(env,`SELECT g.* FROM hnd_recording_grants g JOIN oa_operators o ON o.id=g.created_by JOIN oa_operators p ON p.id=g.person_id WHERE g.recording_id=? AND g.person_id=? AND g.revoked_at IS NULL AND g.expires_at>? AND o.role='owner' AND o.status='active' AND o.version=g.owner_version AND p.status='active' AND p.version=g.person_version ORDER BY g.created_at DESC LIMIT 1`,recordingId,actor.operator.id,Date.now()).first<Grant>()
}
// Shared content authorization never mints a playback grant or fetches media.
export async function recordingAccess(env:Bindings,actor:Session,target:string){
 const grant=await currentGrant(env,actor,target)
 if(!grant)throw new Fault('exact_person_recording_grant_required',403)
 const r=await recording(env,target)
 await captureContentAccess(env,target)
 const fences=()=>[nativeFence(env,actor),grantFence(env,actor,grant),sourceFence(env,r),recordingFence(env,r),captureContentFence(env,target)]
 await env.DB.batch([...fences(),sql(env,'DELETE FROM hnd_guard')])
 return {fences,applied:playbackPolicy(actor,grant,r)}
}
export async function recordingDoor(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response|null>{
 const url=new URL(request.url),path=url.pathname,base='/api/handset/recordings'
 if(!path.startsWith(base+'/'))return null
 if(url.search)throw new Fault('unexpected_recording_query')
 if(request.method==='POST'&&path===base+'/grants'){
  owner(actor);const v=value!;keys(v,['recordingId','personId','expiresAt','confirm'])
  if(v.confirm!=='approve consented recording for this exact person')throw new Fault('exact_person_recording_consent_required',403)
  const r=await recording(env,text(v.recordingId,'recordingId')),person=text(v.personId,'personId'),expires=integer(v.expiresAt,'expiresAt',Date.now()+1000,Date.now()+3600000),target=id()
  const p=await sql(env,"SELECT version FROM oa_operators WHERE id=? AND status='active'",person).first<{version:number}>()
  if(!p)throw new Fault('active_person_required',409)
  await commit(env,actor,'recording.grant',r.id,'completed',[sourceFence(env,r),recordingFence(env,r),guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'",person,p.version),sql(env,'INSERT INTO hnd_recording_grants VALUES (?,?,?,?,?,?,?,?,?)',target,r.id,person,p.version,actor.operator.id,actor.operator.version,expires,null,Date.now())],true,playbackPolicy(actor,{id:target,owner_version:actor.operator.version},r))
  return json({id:target,recordingId:r.id,personId:person,expiresAt:expires,scope:'one owner-attested recording for this exact person; no other data, call or administration rights'},201)
 }
 const revoke=path.match(/^\/api\/handset\/recordings\/grants\/([^/]+)\/revoke$/)
 if(request.method==='POST'&&revoke){
  owner(actor);keys(value!,[])
  const grant=await sql(env,'SELECT * FROM hnd_recording_grants WHERE id=?',revoke[1]).first<Grant>()
  if(!grant)throw new Fault('recording_grant_not_found',404)
  await commit(env,actor,'recording.revoke',grant.id,'completed',[guard(env,'SELECT count(*) FROM hnd_recording_grants WHERE id=? AND owner_version=?',grant.id,grant.owner_version),sql(env,'UPDATE hnd_recording_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',Date.now(),grant.id)],true,playbackPolicy(actor,grant))
  return json({revoked:true})
 }
 const play=path.match(/^\/api\/handset\/recordings\/([^/]+)\/playback$/)
 if(request.method!=='GET'||!play)throw new Fault('method_not_allowed',405)
 // No role, ownership or executive delegation implies playback permission.
 const grant=await currentGrant(env,actor,play[1])
 const auditActor=await actorRef(env.DB,actor.operator.id)
 if(!grant){await append(env,auditActor,'recording.playback','installation','refused',[],null,playbackPolicy(actor));throw new Fault('exact_person_recording_grant_required',403)}
 const r=await recording(env,play[1]);await captureContentAccess(env,play[1])
 const fences=()=>[nativeFence(env,actor),grantFence(env,actor,grant),sourceFence(env,r),recordingFence(env,r),captureContentFence(env,play[1])]
 const applied=playbackPolicy(actor,grant,r)
 await append(env,auditActor,'recording.playback',r.id,'uncertain',fences(),null,applied)
 try{
  if(!env.HANDSET_TWILIO_AUTH_TOKEN)throw new Fault('recording_provider_unavailable',503)
  const endpoint=`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(r.account_id)}/Recordings/${encodeURIComponent(r.external_id)}`
  const headers={authorization:'Basic '+btoa(r.account_id+':'+env.HANDSET_TWILIO_AUTH_TOKEN)}
  const meta=await fetch(endpoint+'.json',{headers,redirect:'manual',signal:AbortSignal.timeout(5000)})
  if(meta.status!==200)throw new Fault('recording_provider_unavailable',503)
  const receipt=await meta.json() as Record<string,unknown>
  if(receipt.sid!==r.external_id||receipt.account_sid!==r.account_id||receipt.call_sid!==r.parent_external||receipt.status!=='completed')throw new Fault('recording_provider_identity_mismatch',502)
  // Repeat revocation after metadata readback and before fetching bytes.
  await env.DB.batch([...fences(),sql(env,'DELETE FROM hnd_guard')])
  const media=await fetch(endpoint+'.wav',{headers,redirect:'manual',signal:AbortSignal.timeout(5000)})
  if(media.status!==200||!/^audio\/(?:wav|x-wav|wave)(?:;|$)/i.test(media.headers.get('content-type')??''))throw new Fault('recording_media_unavailable',503)
  const length=Number(media.headers.get('content-length'))
  if(!length||!Number.isSafeInteger(length)||length>10_000_000){await media.body?.cancel();throw new Fault('recording_media_size_unqualified',413)}
  const reader=media.body?.getReader();if(!reader)throw new Fault('recording_media_unavailable',503)
  const chunks:Uint8Array[]=[];let size=0
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>length)throw new Fault('recording_media_size_unqualified',413);chunks.push(part.value)}}finally{await reader.cancel()}
  if(size!==length)throw new Fault('recording_media_incomplete',503)
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  // Never publish bytes if authority changed while the provider was responding.
  await append(env,auditActor,'recording.playback',r.id,'completed',fences(),null,applied)
  return new Response(bytes,{headers:{'content-type':'audio/wav','content-length':String(bytes.length),'cache-control':'private, no-store','content-disposition':'inline; filename="recording.wav"','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; sandbox"}})
 }catch(error){await append(env,auditActor,'recording.playback',r.id,'failed',[],null,applied);if(error instanceof Fault)throw error;if(String(error).includes('CHECK constraint failed'))throw new Fault('recording_authority_changed',409);throw new Fault('recording_playback_unavailable',503)}
}

export async function recordingsPage(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response|null>{
 const path=new URL(request.url).pathname
 const captureResponse=await captureDoor(request,env,actor,value)??await capturePage(request,env,actor,value)
 if(captureResponse)return captureResponse
 if(path.startsWith('/api/handset/recordings/'))return recordingDoor(request,env,actor,value)
 const selected=path.match(/^\/app\/recordings\/([0-9a-f-]{36})$/)
 if(selected&&request.method==='GET'){
  const grant=await currentGrant(env,actor,selected[1])
  if(!grant){await append(env,await actorRef(env.DB,actor.operator.id),'recording.playback','installation','refused',[],null,playbackPolicy(actor));throw new Fault('exact_person_recording_grant_required',403)}
  await recording(env,selected[1])
  const response=await consolePage('Owner-attested exact-person playback',`<p>The owner attested playback for your exact identity until ${e(new Date(grant.expires_at).toISOString())}. Revocation is checked again when requesting audio. A stream already received by a listener cannot be recalled.</p><audio controls preload="none" aria-label="Approved recording" src="/api/handset/recordings/${e(selected[1])}/playback"></audio><p><a href="/app/recordings">Return to recordings</a></p>`)
  response.headers.set('content-security-policy',response.headers.get('content-security-policy')+"; media-src 'self'")
  return response
 }
 if(path==='/app/recordings'&&request.method==='GET'){
  const grants=(await sql(env,`SELECT g.id,g.recording_id,g.expires_at FROM hnd_recording_grants g JOIN oa_operators o ON o.id=g.created_by WHERE g.person_id=? AND g.person_version=? AND g.revoked_at IS NULL AND g.expires_at>? AND o.role='owner' AND o.status='active' AND o.version=g.owner_version ORDER BY g.created_at DESC`,actor.operator.id,actor.operator.version,Date.now()).all<{id:string;recording_id:string;expires_at:number}>()).results
  const records=actor.operator.role==='owner'?(await sql(env,`SELECT r.id FROM hnd_records r WHERE r.kind='recording' AND ${completedRecording} ORDER BY r.received_at DESC LIMIT 100`).all<{id:string}>()).results:[]
  const people=actor.operator.role==='owner'?(await sql(env,"SELECT id,display_name FROM oa_operators WHERE status='active' ORDER BY display_name").all<{id:string;display_name:string}>()).results:[]
  return consolePage('Recordings',`<details class="hs-tertiary"><summary>How playback approval works</summary><p>Executive delegation never conveys recording rights. Every playback needs a current owner-attested approval for the exact person and recording. Playback fetches provider bytes on demand without keeping a media copy.</p></details><p><a href="/app/recordings/capture">Recording controls and retention</a></p><p><a href="/app/transcripts">Search permitted transcript text</a></p><h2>My approved recordings</h2><ul>${grants.map(g=>`<li>Recording ${e(g.recording_id)} · expires ${e(new Date(g.expires_at).toISOString())}<p><a href="/app/recordings/${e(g.recording_id)}">Play approved recording ${e(g.recording_id)}</a></p></li>`).join('')||'<li>No current recording approvals.</li>'}</ul>${actor.operator.role==='owner'?`<h2>Approvals</h2><details class="hs-tertiary"><summary>Approve playback for a person</summary><p class="hs-hint">Attest that you verified participant consent and this exact person’s need. This records your attestation; live capture consent is not qualified in this app, and this screen does not prove capture consent or US custody qualification.</p><form method="post" action="/app/recordings/grants"><label for="recording-recordingId">Provider recording</label><select id="recording-recordingId" name="recordingId">${records.map(r=>`<option value="${e(r.id)}">${e(r.id)}</option>`).join('')}</select><label for="recording-personId">Exact approved person</label><select id="recording-personId" name="personId">${people.map(p=>`<option value="${e(p.id)}">${e(p.display_name)} · ${e(p.id)}</option>`).join('')}</select>${field('Recording approval expiry (UTC)','expiresAt','','datetime-local')}<label><input type="checkbox" name="confirm" value="approve consented recording for this exact person" required>I attest participant consent and approve playback for this exact person</label><button>Approve recording playback</button></form></details><details class="hs-tertiary"><summary>Revoke a recording approval</summary><form method="post" action="/app/recordings/revoke">${field('Recording grant ID','grantId')}<button>Revoke recording approval now</button></form></details>`:''}`)
 }
 if(request.method==='POST'&&['/app/recordings/grants','/app/recordings/revoke'].includes(path)){
  owner(actor);const v={...value}
  if(path.endsWith('/grants')&&typeof v.expiresAt==='string')v.expiresAt=new Date(v.expiresAt+'Z').getTime()
  let api='/api/handset/recordings/grants'
  if(path.endsWith('/revoke')){keys(v,['grantId']);api+='/'+encodeURIComponent(text(v.grantId,'grantId'))+'/revoke';delete v.grantId}
  const requestUrl=new URL(request.url);requestUrl.pathname=api
  const result=await recordingDoor(new Request(requestUrl,{method:'POST'}),env,actor,v)
  if(result&&!result.ok)return result
  return consolePage('Recording approval recorded',`<p role="status">${path.endsWith('/grants')?'Exact-person approval recorded. Grant ID '+e((await result!.json() as {id:string}).id):'Recording approval revoked.'}</p><a href="/app/recordings">Return to recordings</a>`)
 }
 throw new Fault('not_found',404)
}
