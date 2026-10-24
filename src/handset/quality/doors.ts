import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { choice, Fault, id, integer, json, keys, object, owner, text, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import { guard, nativeFence, sql } from '../delegation/store'
import { recordingAccess } from '../recording/doors'

interface Grant {id:string;team_id:string;person_id:string;person_version:number;role:'agent'|'supervisor';private_notes:number;can_export:number;created_by:string;owner_version:number;expires_at:number}
interface Rubric {id:string;team_id:string;revision:number;criteria:string}
interface Review {id:string;team_id:string;call_id:string;recording_id:string;agent_id:string;rubric_id:string;segments:string;created_by:string;created_at:number}
interface Segment {id:string;startMs:number;endMs:number;text:string}
interface Criterion {id:string;label:string;maxScore:number}
const active=`g.revoked_at IS NULL AND g.expires_at>? AND p.status='active' AND p.version=g.person_version AND o.role='owner' AND o.status='active' AND o.version=g.owner_version`
async function access(env:Bindings,actor:Session,team:string,supervisor=false){
 const g=await sql(env,`SELECT g.* FROM hnd_quality_grants g JOIN oa_operators p ON p.id=g.person_id JOIN oa_operators o ON o.id=g.created_by WHERE g.team_id=? AND g.person_id=? AND ${active} ${supervisor?"AND g.role='supervisor'":''} ORDER BY g.created_at DESC,g.id DESC LIMIT 1`,team,actor.operator.id,Date.now()).first<Grant>()
 if(!g)throw new Fault('quality_access_required',403)
 const fences=()=>[nativeFence(env,actor),guard(env,`SELECT count(*) FROM hnd_quality_grants g JOIN oa_operators p ON p.id=g.person_id JOIN oa_operators o ON o.id=g.created_by WHERE g.id=? AND g.person_id=? AND ${active}`,g.id,actor.operator.id,Date.now())]
 await env.DB.batch([...fences(),sql(env,'DELETE FROM hnd_guard')])
 return {g,fences,applied:{access:{id:g.id,revision:1,ownerVersion:g.owner_version}}}
}
async function rubric(env:Bindings,target:string){const r=await sql(env,'SELECT * FROM hnd_quality_rubrics WHERE id=?',target).first<Rubric>();if(!r)throw new Fault('rubric_not_found',404);return r}
function array(value:unknown,name:string,max:number){if(!Array.isArray(value)||!value.length||value.length>max)throw new Fault('invalid_'+name);return value}
function segments(value:unknown,duration:number):Segment[]{
 const rows=array(value,'segments',100).map(v=>{const s=object(v);keys(s,['id','startMs','endMs','text']);const start=integer(s.startMs,'startMs',0,duration),end=integer(s.endMs,'endMs',start+1,duration);return {id:text(s.id,'segmentId',80),startMs:start,endMs:end,text:text(s.text,'segmentText',2000)}})
 if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new Fault('duplicate_segment')
 for(let i=1;i<rows.length;i++)if(rows[i].startMs<rows[i-1].endMs)throw new Fault('overlapping_or_unordered_segments')
 return rows
}
function grades(value:unknown,r:Rubric,source:Segment[]){
 const criteria=JSON.parse(r.criteria) as Criterion[],rows=array(value,'grades',20).map(v=>{
  const g=object(v);keys(g,['criterionId','score','segmentId','explanation','uncertainty'])
  const criterion=criteria.find(c=>c.id===g.criterionId),segment=source.find(s=>s.id===g.segmentId)
  if(!criterion||!segment)throw new Fault('exact_rubric_and_moment_required')
  return {criterionId:criterion.id,score:integer(g.score,'score',0,criterion.maxScore),segmentId:segment.id,explanation:text(g.explanation,'explanation',2000),uncertainty:text(g.uncertainty,'uncertainty',1000)}
 })
 if(rows.length!==criteria.length||new Set(rows.map(g=>g.criterionId)).size!==criteria.length)throw new Fault('every_criterion_required')
 return JSON.stringify(rows)
}
async function selected(env:Bindings,actor:Session,target:string,supervisor=false){
 const review=await sql(env,'SELECT * FROM hnd_quality_reviews WHERE id=?',target).first<Review>()
 if(!review)throw new Fault('quality_review_not_found',404)
 const a=await access(env,actor,review.team_id,supervisor)
 if(a.g.role==='agent'&&review.agent_id!==actor.operator.id)throw new Fault('quality_review_not_found',404)
 const media=await recordingAccess(env,actor,review.recording_id),r=await rubric(env,review.rubric_id)
 return {review,r,a,fences:()=>[...a.fences(),...media.fences()],applied:{...a.applied,...media.applied,quality:{id:r.id,revision:r.revision}}}
}
async function detail(env:Bindings,actor:Session,target:string,exporting=false){
 const s=await selected(env,actor,target),{review,r,a}=s
 if(exporting&&!a.g.can_export)throw new Fault('quality_export_approval_required',403)
 const scores=(await sql(env,'SELECT * FROM hnd_quality_scores WHERE review_id=? ORDER BY created_at,id',target).all<{grades:string}>()).results.map(score=>({...score,grades:JSON.parse(score.grades)}))
 const comments=(await sql(env,`SELECT * FROM hnd_quality_comments WHERE review_id=? AND (kind!='employee_note' OR ?=1) ORDER BY created_at,id`,target,a.g.private_notes).all()).results
 await commit(env,actor,exporting?'quality.export':'quality.read',target,'completed',s.fences(),false,s.applied)
 return {review:{...review,segments:JSON.parse(review.segments)},rubric:{...r,criteria:JSON.parse(r.criteria)},scores,comments,sourceKind:'owner_supplied_text',speechVerified:false,aiScored:false,personnelAction:'none'}
}
export async function qualityDoor(request:Request,env:Bindings,actor:Session,v?:ObjectValue):Promise<Response>{
 const url=new URL(request.url),path=url.pathname.slice('/api/handset/quality'.length),write=request.method==='POST',read=request.method==='GET'
 if(url.search)throw new Fault('unexpected_quality_query')
 if(!write&&!read)throw new Fault('method_not_allowed',405)
 if(write&&path==='/teams'){
  owner(actor);keys(v!,['name']);const target=id(),name=text(v!.name,'name',100)
  await commit(env,actor,'quality.team',target,'completed',[sql(env,'INSERT INTO hnd_quality_teams VALUES (?,?,?,?)',target,name,actor.operator.id,Date.now())])
  return json({id:target,name},201)
 }
 if(write&&path==='/grants'){
  owner(actor);keys(v!,['teamId','personId','role','privateNotes','export','expiresAt','confirm'])
  if(v!.confirm!=='approve exact quality access without recording rights')throw new Fault('quality_approval_required',403)
  const team=text(v!.teamId,'teamId'),person=text(v!.personId,'personId'),role=choice(v!.role,['agent','supervisor'],'role'),expires=integer(v!.expiresAt,'expiresAt',Date.now()+1000,Date.now()+86400000)
  if(typeof v!.export!=='boolean'||typeof v!.privateNotes!=='boolean'||role==='agent'&&v!.privateNotes)throw new Fault('separate_supervisor_notes_scope_required')
  const p=await sql(env,"SELECT version FROM oa_operators WHERE id=? AND status='active'",person).first<{version:number}>()
  if(!p)throw new Fault('active_person_required',409)
  const target=id()
  await commit(env,actor,'quality.grant',target,'completed',[
   guard(env,'SELECT count(*) FROM hnd_quality_teams WHERE id=?',team),guard(env,"SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'",person,p.version),
   sql(env,'INSERT INTO hnd_quality_grants VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)',target,team,person,p.version,role,v!.privateNotes?1:0,v!.export?1:0,actor.operator.id,actor.operator.version,expires,Date.now()),
  ])
  return json({id:target,teamId:team,personId:person,role,privateNotes:v!.privateNotes,export:v!.export,expiresAt:expires,recordingRights:false},201)
 }
 const revoke=path.match(/^\/grants\/([^/]+)\/revoke$/)
 if(write&&revoke){
  owner(actor);keys(v!,[]);const g=await sql(env,'SELECT team_id,person_id FROM hnd_quality_grants WHERE id=?',revoke[1]).first<Grant>()
  if(!g)throw new Fault('quality_grant_not_found',404)
  await commit(env,actor,'quality.revoke',revoke[1],'completed',[sql(env,'UPDATE hnd_quality_grants SET revoked_at=COALESCE(revoked_at,?) WHERE team_id=? AND person_id=?',Date.now(),g.team_id,g.person_id)])
  return json({revoked:true,scope:'all parallel quality grants for this person and team',recordingRightsChanged:false})
 }
 if(write&&path==='/rubrics'){
  owner(actor);keys(v!,['teamId','expectedRevision','criteria']);const team=text(v!.teamId,'teamId'),a=await access(env,actor,team,true),expected=integer(v!.expectedRevision,'expectedRevision',0)
  const criteria=array(v!.criteria,'criteria',20).map(v=>{const c=object(v);keys(c,['id','label','maxScore']);return {id:text(c.id,'criterionId',80),label:text(c.label,'criterionLabel',200),maxScore:integer(c.maxScore,'maxScore',1,100)}})
  if(new Set(criteria.map(c=>c.id)).size!==criteria.length)throw new Fault('duplicate_criterion')
  const target=id()
  await commit(env,actor,'quality.rubric',target,'completed',[...a.fences(),guard(env,'SELECT COALESCE(MAX(revision),0)=? FROM hnd_quality_rubrics WHERE team_id=?',expected,team),sql(env,'INSERT INTO hnd_quality_rubrics VALUES (?,?,?,?,?,?)',target,team,expected+1,JSON.stringify(criteria),actor.operator.id,Date.now())],true,{...a.applied,quality:{id:target,revision:expected+1}})
  return json({id:target,teamId:team,revision:expected+1,criteria},201)
 }
 if(write&&path==='/reviews'){
  owner(actor);keys(v!,['teamId','callId','recordingId','agentId','rubricId','segments','grades','confirm'])
  if(v!.confirm!=='attest permission for supplied text human review only')throw new Fault('quality_text_consent_required',403)
  const team=text(v!.teamId,'teamId'),a=await access(env,actor,team,true),call=text(v!.callId,'callId'),recording=text(v!.recordingId,'recordingId'),agent=text(v!.agentId,'agentId'),r=await rubric(env,text(v!.rubricId,'rubricId'))
  if(r.team_id!==team)throw new Fault('rubric_team_mismatch',403)
  const media=await recordingAccess(env,actor,recording)
  const source=await sql(env,"SELECT COALESCE((SELECT json_extract(m.data,'$.durationSeconds') FROM hnd_records m WHERE m.parent_id=r.id AND m.kind='media' AND json_extract(m.data,'$.mime')='audio/wav' ORDER BY m.received_at DESC,m.id DESC LIMIT 1),json_extract(r.data,'$.durationSeconds')) AS seconds FROM hnd_records r JOIN hnd_records c ON c.id=r.parent_id WHERE r.id=? AND r.parent_id=? AND c.kind='call_session'",recording,call).first<{seconds:number}>()
  if(!source||!Number.isSafeInteger(source.seconds)||source.seconds<=0)throw new Fault('exact_available_call_recording_required',409)
  const sourceSegments=segments(v!.segments,source.seconds*1000),score=grades(v!.grades,r,sourceSegments),target=id(),scoreId=id(),now=Date.now()
  await commit(env,actor,'quality.review',target,'completed',[
   ...a.fences(),...media.fences(),guard(env,`SELECT count(*)>0 FROM hnd_quality_grants g JOIN oa_operators p ON p.id=g.person_id JOIN oa_operators o ON o.id=g.created_by WHERE g.team_id=? AND g.person_id=? AND g.role='agent' AND ${active}`,team,agent,Date.now()),
   guard(env,'SELECT MAX(revision)=? FROM hnd_quality_rubrics WHERE team_id=?',r.revision,team),
   guard(env,'SELECT NOT EXISTS(SELECT 1 FROM hnd_quality_reviews WHERE call_id=?)',call),
   sql(env,'INSERT INTO hnd_quality_reviews VALUES (?,?,?,?,?,?,?,?,?)',target,team,call,recording,agent,r.id,JSON.stringify(sourceSegments),actor.operator.id,now),
   sql(env,'INSERT INTO hnd_quality_scores VALUES (?,?,NULL,?,?,?,?)',scoreId,target,score,'human_review',actor.operator.id,now),
  ],true,{...a.applied,...media.applied,quality:{id:r.id,revision:r.revision}})
  return json({id:target,scoreId,sourceKind:'owner_supplied_text',aiScored:false},201)
 }
 const reviewPath=path.match(/^\/reviews\/([^/]+)(?:\/(export|override|comments))?$/)
 if(reviewPath){
  const [,target,action]=reviewPath
  if(read&&(!action||action==='export')){
   const response=json(await detail(env,actor,target,action==='export'))
   if(action==='export')response.headers.set('content-disposition','attachment; filename="human-quality-review.json"')
   return response
  }
  if(write&&action==='override'){
   keys(v!,['scoreId','grades']);const s=await selected(env,actor,target,true),scoreId=text(v!.scoreId,'scoreId'),score=grades(v!.grades,s.r,JSON.parse(s.review.segments)),newId=id()
   await commit(env,actor,'quality.override',target,'completed',[
    ...s.fences(),guard(env,'SELECT count(*) FROM hnd_quality_scores s WHERE s.id=? AND s.review_id=? AND NOT EXISTS(SELECT 1 FROM hnd_quality_scores n WHERE n.supersedes_id=s.id)',scoreId,target),
    sql(env,'INSERT INTO hnd_quality_scores VALUES (?,?,?,?,?,?,?)',newId,target,scoreId,score,'human_override',actor.operator.id,Date.now()),
   ],false,s.applied)
   return json({id:newId,supersedesId:scoreId,originalPreserved:true},201)
  }
  if(write&&action==='comments'){
   keys(v!,['scoreId','segmentId','kind','body']);const s=await selected(env,actor,target),kind=choice(v!.kind,['coaching','self_review','employee_note'],'kind'),scoreId=text(v!.scoreId,'scoreId'),segment=text(v!.segmentId,'segmentId'),body=text(v!.body,'body',4000)
   if(kind==='self_review'&&s.review.agent_id!==actor.operator.id||kind!=='self_review'&&s.a.g.role!=='supervisor'||kind==='employee_note'&&!s.a.g.private_notes)throw new Fault('quality_comment_scope_required',403)
   if(!(JSON.parse(s.review.segments) as Segment[]).some(m=>m.id===segment))throw new Fault('exact_moment_required')
   const targetId=id()
   await commit(env,actor,'quality.comment',target,'completed',[
    ...s.fences(),guard(env,'SELECT count(*) FROM hnd_quality_scores WHERE id=? AND review_id=?',scoreId,target),
    sql(env,'INSERT INTO hnd_quality_comments VALUES (?,?,?,?,?,?,?,?)',targetId,target,scoreId,segment,kind,body,actor.operator.id,Date.now()),
   ],false,s.applied)
   return json({id:targetId,kind,customerVisible:false},201)
  }
  throw new Fault('method_not_allowed',405)
 }
 throw new Fault('not_found',404)
}
