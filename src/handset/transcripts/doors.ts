import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, choice, id, integer, json, keys, owner, text, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { guard, nativeFence, sql } from '../delegation/store'
import { activeSourceById, sourceFence } from '../providers/sources'

interface Transcript {id:string;recording_id:string;source_id:string;source_revision:number;duration_ms:number;state:'supplied'|'missing';reason:string|null;original:string;created_by:string;created_at:number}
interface Segment {id:string;speaker:string;language:'en'|'es';startMs:number;endMs:number;text:string;confidence:number}
interface Annotation {id:string;transcript_id:string;segment_id:string;kind:string;text:string;owner_id:string|null;due_at:number|null;due_state:string|null;created_by:string;created_at:number}
interface Correction {revision:number;segment_id:string;replacement:string;created_by:string;created_at:number}
const permission=`g.revoked_at IS NULL AND g.expires_at>? AND p.status='active' AND p.version=g.person_version AND o.status='active' AND o.role='owner' AND o.version=g.owner_version`
function accessFence(env:Bindings,actor:Session,target:string){
 return guard(env,`SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_transcript_access g JOIN oa_operators p ON p.id=g.person_id JOIN oa_operators o ON o.id=g.created_by WHERE g.transcript_id=? AND g.person_id=? AND ${permission}) THEN 1 ELSE 0 END`,target,actor.operator.id,Date.now())
}
async function metadata(env:Bindings,target:string){
 const row=await sql(env,'SELECT * FROM hnd_transcripts WHERE id=?',target).first<Transcript>()
 if(!row)throw new Fault('transcript_unavailable',404)
 const source=await activeSourceById(env,row.source_id)
 if(!source||source.revision!==row.source_revision)throw new Fault('transcript_source_unavailable',403)
 return {row,source}
}
async function current(env:Bindings,actor:Session,target:string){
 const permitted=await sql(env,`SELECT g.id FROM hnd_transcript_access g JOIN oa_operators p ON p.id=g.person_id JOIN oa_operators o ON o.id=g.created_by WHERE g.transcript_id=? AND g.person_id=? AND ${permission} LIMIT 1`,target,actor.operator.id,Date.now()).first()
 if(!permitted)throw new Fault('transcript_access_required',403)
 const {row,source}=await metadata(env,target)
 const fences=()=>[nativeFence(env,actor),accessFence(env,actor,target),sourceFence(env,source)]
 return {row,source,fences}
}
async function read(env:Bindings,actor:Session,target:string){
 const {row,source,fences}=await current(env,actor,target)
 const results=await env.DB.batch([...fences(),sql(env,'SELECT * FROM hnd_transcript_corrections WHERE transcript_id=? ORDER BY revision DESC LIMIT 201',target),sql(env,'SELECT * FROM hnd_transcript_annotations WHERE transcript_id=? ORDER BY created_at DESC,id DESC LIMIT 201',target),sql(env,'SELECT c.* FROM hnd_transcript_corrections c WHERE c.transcript_id=? AND c.revision=(SELECT max(latest.revision) FROM hnd_transcript_corrections latest WHERE latest.transcript_id=c.transcript_id AND latest.segment_id=c.segment_id)',target),sql(env,'DELETE FROM hnd_guard')])
 await commit(env,actor,'transcript.read',target,'completed',fences(),false,sourcePolicy(source))
 const recording=await sql(env,'SELECT occurred_at,parent_id FROM hnd_records WHERE id=?',row.recording_id).first<{occurred_at:number;parent_id:string|null}>()
 const corrections=(results[3].results as unknown as Correction[]).slice(0,200).reverse(),effectiveCorrections=results[5].results as unknown as Correction[],segments=JSON.parse(row.original) as Segment[]
 const effective=segments.map(segment=>({...segment,text:effectiveCorrections.find(c=>c.segment_id===segment.id)?.replacement??segment.text,lowConfidence:segment.confidence<0.8,moment:{recordingId:row.recording_id,startMs:segment.startMs,endMs:segment.endMs}}))
 return {id:row.id,recordingId:row.recording_id,recordedAt:recording!.occurred_at,callId:recording!.parent_id,numberId:source.number_id,sourceId:row.source_id,sourceRevision:row.source_revision,state:row.state,reason:row.reason,provenance:'owner-supplied text; speech accuracy and capture consent are unqualified',original:segments,segments:effective,corrections,annotations:(results[4].results as unknown as Annotation[]).slice(0,200).reverse(),historyBounded:results[3].results.length>200,annotationsBounded:results[4].results.length>200,revision:corrections.at(-1)?.revision??0}
}
function segments(value:unknown,duration:number):Segment[]{
 if(!Array.isArray(value)||!value.length||value.length>200)throw new Fault('invalid_segments')
 const seen=new Set<string>()
 return value.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Fault('invalid_segment')
  const v=raw as ObjectValue;keys(v,['id','speaker','language','startMs','endMs','text','confidence'])
  const segment={id:text(v.id,'segmentId',100),speaker:text(v.speaker,'speaker',100),language:choice(v.language,['en','es'],'language'),startMs:integer(v.startMs,'startMs',0,duration-1),endMs:integer(v.endMs,'endMs',1,duration),text:text(v.text,'text',4000),confidence:Number(v.confidence)}
  if(segment.endMs<=segment.startMs||seen.has(segment.id)||typeof v.confidence!=='number'||!Number.isFinite(segment.confidence)||segment.confidence<0||segment.confidence>1)throw new Fault('invalid_segment')
  seen.add(segment.id);return segment
 })
}
async function grant(env:Bindings,actor:Session,target:string,personId:string,expires:number,statements:D1PreparedStatement[]=[]){
 owner(actor)
 const p=await sql(env,"SELECT version FROM oa_operators WHERE id=? AND status='active'",personId).first<{version:number}>()
 if(!p)throw new Fault('active_person_required',409)
 const accessId=id()
 await commit(env,actor,'transcript.grant',target,'completed',[...statements,nativeFence(env,actor),guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'",personId,p.version),sql(env,'INSERT INTO hnd_transcript_access VALUES (?,?,?,?,?,?,?,NULL,?)',accessId,target,personId,p.version,actor.operator.id,actor.operator.version,expires,Date.now())])
 return {accessId,transcriptId:target,personId,expiresAt:expires}
}
export async function transcriptDoor(request:Request,env:Bindings,actor:Session,v?:ObjectValue):Promise<Response|null>{
 const url=new URL(request.url),base='/api/handset/transcripts',path=url.pathname
 if(path!==base&&!path.startsWith(base+'/'))return null
 if(path===base&&request.method==='POST'){
  owner(actor);keys(v!,['recordingId','durationMs','state','reason','segments','confirm'])
  if(v!.confirm!=='authorize supplied transcript for my exact identity')throw new Fault('explicit_transcript_consent_required',403)
  const recordingId=text(v!.recordingId,'recordingId'),duration=integer(v!.durationMs,'durationMs',1,14400000),state=choice(v!.state,['supplied','missing'],'state')
  const linked=await sql(env,`SELECT rs.source_id FROM hnd_records r JOIN hnd_record_sources rs ON rs.record_id=r.id WHERE r.id=? AND r.kind='recording' AND json_extract(r.data,'$.providerStatus')='completed'`,recordingId).first<{source_id:string}>()
  const source=linked?await activeSourceById(env,linked.source_id):null
  if(!source)throw new Fault('current_recording_source_required',409)
  const data=state==='supplied'?segments(v!.segments,duration):[]
  const reason=state==='missing'?text(v!.reason,'reason',300):null
  if(state==='missing'&&v!.segments!==undefined)throw new Fault('missing_transcript_has_no_text')
  const target=id(),created=Date.now()
  const result=await grant(env,actor,target,actor.operator.id,created+3600000,[sourceFence(env,source),guard(env,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_transcripts WHERE recording_id=?) THEN 0 ELSE 1 END',recordingId),sql(env,'INSERT INTO hnd_transcripts VALUES (?,?,?,?,?,?,?,?,?,?)',target,recordingId,source.id,source.revision,duration,state,reason,JSON.stringify(data),actor.operator.id,created)])
  return json({...result,state},201)
 }
 if(path===base&&request.method==='GET'){
  for(const key of url.searchParams.keys())if(!['q','recordingId','from','to','numberId','ownerId'].includes(key))throw new Fault('unsupported_search_filter')
  const query=text(url.searchParams.get('q')??'','query',200,true).toLocaleLowerCase(),recording=url.searchParams.get('recordingId'),number=url.searchParams.get('numberId'),person=url.searchParams.get('ownerId')
  const from=url.searchParams.has('from')?integer(Number(url.searchParams.get('from')),'from',0,8640000000000000):0,to=url.searchParams.has('to')?integer(Number(url.searchParams.get('to')),'to',from,8640000000000000):8640000000000000
  const candidates=await sql(env,`SELECT DISTINCT t.id FROM hnd_transcripts t JOIN hnd_records r ON r.id=t.recording_id JOIN hnd_sources s ON s.id=t.source_id JOIN hnd_transcript_access g ON g.transcript_id=t.id JOIN oa_operators p ON p.id=g.person_id JOIN oa_operators o ON o.id=g.created_by WHERE g.person_id=? AND ${permission} AND (? IS NULL OR t.recording_id=?) AND r.occurred_at BETWEEN ? AND ? AND (? IS NULL OR s.number_id=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM hnd_transcript_annotations a WHERE a.transcript_id=t.id AND a.owner_id=?)) ORDER BY r.occurred_at DESC,t.id LIMIT 50`,actor.operator.id,Date.now(),recording,recording,from,to,number,number,person,person).all<{id:string}>()
  const matches=[]
  for(const candidate of candidates.results){
   try{
    const item=await read(env,actor,candidate.id)
    const moments=item.segments.filter(s=>s.text.toLocaleLowerCase().includes(query))
    if(!query||moments.length)matches.push({id:item.id,recordingId:item.recordingId,recordedAt:item.recordedAt,callId:item.callId,numberId:item.numberId,sourceId:item.sourceId,sourceRevision:item.sourceRevision,state:item.state,reason:item.reason,provenance:item.provenance,segments:moments.slice(0,5),annotations:item.annotations.filter(a=>moments.some(s=>s.id===a.segment_id)).slice(0,10),momentsBounded:moments.length>5})
   }catch(error){if(error instanceof Fault&&[403,404].includes(error.status))continue;throw error}
  }
  return json({matches,bounded:true,limit:50})
 }
 const match=path.match(/^\/api\/handset\/transcripts\/([^/]+)(?:\/(corrections|annotations|grants|revoke))?$/)
 if(!match)throw new Fault('not_found',404)
 const target=match[1],action=match[2]
 if(url.search)throw new Fault('unexpected_transcript_query')
 if(request.method==='GET'&&!action)return json(await read(env,actor,target))
 if(request.method!=='POST'||!action)throw new Fault('method_not_allowed',405)
 owner(actor)
 if(action==='grants'){
  keys(v!,['personId','expiresAt','confirm'])
  if(v!.confirm!=='approve this exact person to read transcript text')throw new Fault('exact_transcript_reader_required',403)
  const {source}=await metadata(env,target)
  return json(await grant(env,actor,target,text(v!.personId,'personId'),integer(v!.expiresAt,'expiresAt',Date.now()+1000,Date.now()+3600000),[sourceFence(env,source)]),201)
 }
 if(action==='revoke'){
  keys(v!,['personId'])
  if(!await sql(env,'SELECT id FROM hnd_transcripts WHERE id=?',target).first())throw new Fault('transcript_unavailable',404)
  await commit(env,actor,'transcript.revoke',target,'completed',[nativeFence(env,actor),sql(env,'UPDATE hnd_transcript_access SET revoked_at=COALESCE(revoked_at,?) WHERE transcript_id=? AND person_id=?',Date.now(),target,text(v!.personId,'personId'))])
  return json({revoked:true})
 }
 const {row,fences}=await current(env,actor,target)
 if(row.state==='missing')throw new Fault('transcript_missing',409)
 const original=JSON.parse(row.original) as Segment[],segmentId=text(v!.segmentId,'segmentId'),segment=original.find(s=>s.id===segmentId)
 if(!segment)throw new Fault('transcript_moment_required',400)
 if(action==='corrections'){
  keys(v!,['segmentId','text','revision'])
  const revision=integer(v!.revision,'revision',0),replacement=text(v!.text,'text',4000)
  await commit(env,actor,'transcript.correct',target,'completed',[...fences(),guard(env,'SELECT CASE WHEN COALESCE((SELECT max(revision) FROM hnd_transcript_corrections WHERE transcript_id=?),0)=? THEN 1 ELSE 0 END',target,revision),sql(env,'INSERT INTO hnd_transcript_corrections VALUES (?,?,?,?,?,?)',target,revision+1,segmentId,replacement,actor.operator.id,Date.now())])
  return json({revision:revision+1},201)
 }
 keys(v!,['segmentId','kind','text','ownerId','dueAt','dueState','confirm'])
 const kind=choice(v!.kind,['summary','topic','sentiment','action','promise'],'kind'),content=text(v!.text,'text',2000),isAction=kind==='action'||kind==='promise'
 const person=isAction?text(v!.ownerId,'ownerId'):null,dueAt=isAction&&v!.dueAt!==undefined?integer(v!.dueAt,'dueAt',0,8640000000000000):null,dueState=isAction?choice(v!.dueState,['scheduled','pending'],'dueState'):null
 if(kind==='promise'&&v!.confirm!=='I confirm this exact cited promise')throw new Fault('human_promise_confirmation_required',403)
 if(isAction&&(dueState==='scheduled'&&dueAt===null||dueState==='pending'&&dueAt!==null))throw new Fault('explicit_due_state_required')
 const annotationId=id()
 await commit(env,actor,'transcript.annotate',target,'completed',[...fences(),...(person?[guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND status='active'",person)]:[]),sql(env,'INSERT INTO hnd_transcript_annotations VALUES (?,?,?,?,?,?,?,?,?,?)',annotationId,target,segmentId,kind,content,person,dueAt,dueState,actor.operator.id,Date.now())])
 return json({id:annotationId,kind,moment:{recordingId:row.recording_id,startMs:segment.startMs,endMs:segment.endMs}},201)
}
