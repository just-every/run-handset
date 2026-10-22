import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { actorRef, append, commit } from '../audit/store'
import { Fault, id, integer, json, keys, owner, text, consolePage, escape as e, field, type ObjectValue } from '../core'
import { guard, nativeFence, sql } from '../delegation/store'

interface Recording {id:string;source_id:string;external_id:string;account_id:string;source_owner:string;source_owner_version:number;parent_external:string}
async function recording(env:Bindings,target:string){
 const row=await sql(env,`SELECT r.id,rs.source_id,so.external_id,s.account_id,s.owner_id AS source_owner,s.owner_version AS source_owner_version,parent.external_id AS parent_external FROM hnd_records r JOIN hnd_record_sources rs ON rs.record_id=r.id JOIN hnd_sources s ON s.id=rs.source_id JOIN hnd_source_objects so ON so.record_id=r.id AND so.source_id=s.id JOIN hnd_source_objects parent ON parent.record_id=r.parent_id AND parent.source_id=s.id JOIN oa_operators o ON o.id=s.owner_id WHERE r.id=? AND r.kind='recording' AND json_extract(r.data,'$.providerStatus')='completed' AND s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=s.owner_version`,target).first<Recording>()
 if(!row)throw new Fault('recording_unavailable',404)
 return row
}
const sourceFence=(env:Bindings,r:Recording)=>guard(env,`SELECT count(*) FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id WHERE s.id=? AND s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=s.owner_version AND s.owner_id=? AND s.owner_version=?`,r.source_id,r.source_owner,r.source_owner_version)
interface Grant {id:string;recording_id:string;person_id:string;person_version:number;created_by:string;owner_version:number;expires_at:number;revoked_at:number|null}
const grantFence=(env:Bindings,actor:Session,g:Grant)=>guard(env,`SELECT count(*) FROM hnd_recording_grants g JOIN oa_operators o ON o.id=g.created_by JOIN oa_operators p ON p.id=g.person_id WHERE g.id=? AND g.person_id=? AND g.revoked_at IS NULL AND g.expires_at>? AND p.status='active' AND p.version=g.person_version AND o.role='owner' AND o.status='active' AND o.version=g.owner_version`,g.id,actor.operator.id,Date.now())
async function currentGrant(env:Bindings,actor:Session,recordingId:string){
 return await sql(env,`SELECT g.* FROM hnd_recording_grants g JOIN oa_operators o ON o.id=g.created_by JOIN oa_operators p ON p.id=g.person_id WHERE g.recording_id=? AND g.person_id=? AND g.revoked_at IS NULL AND g.expires_at>? AND o.role='owner' AND o.status='active' AND o.version=g.owner_version AND p.status='active' AND p.version=g.person_version ORDER BY g.created_at DESC LIMIT 1`,recordingId,actor.operator.id,Date.now()).first<Grant>()
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
  await commit(env,actor,'recording.grant',r.id,'completed',[sourceFence(env,r),guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'",person,p.version),sql(env,'INSERT INTO hnd_recording_grants VALUES (?,?,?,?,?,?,?,?,?)',target,r.id,person,p.version,actor.operator.id,actor.operator.version,expires,null,Date.now())])
  return json({id:target,recordingId:r.id,personId:person,expiresAt:expires,scope:'one consented recording; no other data, call or administration rights'},201)
 }
 const revoke=path.match(/^\/api\/handset\/recordings\/grants\/([^/]+)\/revoke$/)
 if(request.method==='POST'&&revoke){owner(actor);keys(value!,[]);await commit(env,actor,'recording.revoke',revoke[1],'completed',[guard(env,'SELECT count(*) FROM hnd_recording_grants WHERE id=?',revoke[1]),sql(env,'UPDATE hnd_recording_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',Date.now(),revoke[1])]);return json({revoked:true})}
 const play=path.match(/^\/api\/handset\/recordings\/([^/]+)\/playback$/)
 if(request.method!=='GET'||!play)throw new Fault('method_not_allowed',405)
 // No role, ownership or executive delegation implies playback permission.
 const grant=await currentGrant(env,actor,play[1])
 const auditActor=await actorRef(env.DB,actor.operator.id)
 if(!grant){await append(env,auditActor,'recording.playback','installation','refused');throw new Fault('exact_person_recording_grant_required',403)}
 const r=await recording(env,play[1]),fences=()=>[nativeFence(env,actor),grantFence(env,actor,grant),sourceFence(env,r)]
 await append(env,auditActor,'recording.playback',r.id,'uncertain',fences())
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
  await append(env,auditActor,'recording.playback',r.id,'completed',fences())
  return new Response(bytes,{headers:{'content-type':'audio/wav','content-length':String(bytes.length),'cache-control':'private, no-store','content-disposition':'inline; filename="recording.wav"','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; sandbox"}})
 }catch(error){await append(env,auditActor,'recording.playback',r.id,'failed');if(error instanceof Fault)throw error;if(String(error).includes('CHECK constraint failed'))throw new Fault('recording_authority_changed',409);throw new Fault('recording_playback_unavailable',503)}
}

export async function recordingsPage(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response|null>{
 const path=new URL(request.url).pathname
 if(path.startsWith('/api/handset/recordings/'))return recordingDoor(request,env,actor,value)
 const selected=path.match(/^\/app\/recordings\/([0-9a-f-]{36})$/)
 if(selected&&request.method==='GET'){
  const grant=await currentGrant(env,actor,selected[1])
  if(!grant){await append(env,await actorRef(env.DB,actor.operator.id),'recording.playback','installation','refused');throw new Fault('exact_person_recording_grant_required',403)}
  await recording(env,selected[1])
  const response=await consolePage('Approved recording playback',`<p>Playback is approved for your exact identity until ${e(new Date(grant.expires_at).toISOString())}. Revocation is checked again when requesting audio. A stream already received by a listener cannot be recalled.</p><audio controls preload="none" aria-label="Approved recording" src="/api/handset/recordings/${e(selected[1])}/playback"></audio><p><a href="/app/recordings">Return to recordings</a></p>`)
  response.headers.set('content-security-policy',response.headers.get('content-security-policy')+"; media-src 'self'")
  return response
 }
 if(path==='/app/recordings'&&request.method==='GET'){
  const grants=(await sql(env,`SELECT g.id,g.recording_id,g.expires_at FROM hnd_recording_grants g JOIN oa_operators o ON o.id=g.created_by WHERE g.person_id=? AND g.person_version=? AND g.revoked_at IS NULL AND g.expires_at>? AND o.role='owner' AND o.status='active' AND o.version=g.owner_version ORDER BY g.created_at DESC`,actor.operator.id,actor.operator.version,Date.now()).all<{id:string;recording_id:string;expires_at:number}>()).results
  const records=actor.operator.role==='owner'?(await sql(env,"SELECT id FROM hnd_records WHERE kind='recording' AND json_extract(data,'$.providerStatus')='completed' ORDER BY received_at DESC LIMIT 100").all<{id:string}>()).results:[]
  const people=actor.operator.role==='owner'?(await sql(env,"SELECT id,display_name FROM oa_operators WHERE status='active' ORDER BY display_name").all<{id:string;display_name:string}>()).results:[]
  return consolePage('Consented recordings',`<p>Executive delegation never conveys recording rights. Every playback, including an owner or supervisor, needs a current exact-person approval for this consented recording. Playback fetches provider bytes on demand without keeping a media copy.</p><h2>My approved recordings</h2><ul>${grants.map(g=>`<li>Recording ${e(g.recording_id)} · expires ${e(new Date(g.expires_at).toISOString())}<p><a href="/app/recordings/${e(g.recording_id)}">Play approved recording ${e(g.recording_id)}</a></p></li>`).join('')||'<li>No current recording approvals.</li>'}</ul>${actor.operator.role==='owner'?`<h2>Owner: exact-person consent approval</h2><p>Approve only after verifying participant consent and the exact person’s need. An owner approval is a recorded attestation; this screen does not prove capture consent or US custody qualification.</p><form method="post" action="/app/recordings/grants"><label for="recording-recordingId">Consented provider recording</label><select id="recording-recordingId" name="recordingId">${records.map(r=>`<option value="${e(r.id)}">${e(r.id)}</option>`).join('')}</select><label for="recording-personId">Exact approved person</label><select id="recording-personId" name="personId">${people.map(p=>`<option value="${e(p.id)}">${e(p.display_name)} · ${e(p.id)}</option>`).join('')}</select>${field('Recording approval expiry (UTC)','expiresAt','','datetime-local')}<label><input type="checkbox" name="confirm" value="approve consented recording for this exact person" required>I approve this consented recording for this exact person</label><button>Approve recording playback</button></form><h2>Revoke recording approval</h2><form method="post" action="/app/recordings/revoke">${field('Recording grant ID','grantId')}<button>Revoke recording approval now</button></form>`:''}<p><a href="/app/front-desk">Return to front desk</a></p>`)
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
