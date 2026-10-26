import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { choice, escape as e, Fault, field, hidden, id, json, keys, owner, page, text, type ObjectValue } from '../core'
import { guard, sql } from '../delegation/store'
import { ensureCall, getPolicy, policyAuthority } from '../consent/store'
import { type Invitation } from './store'
export { tickSurveys } from './store'
export { surveyProviderResponse } from './provider'
const approval='approve this post-call survey'
async function create(env:Bindings,actor:Session,v:ObjectValue){
 keys(v,['callRecordId','channel','confirm'])
 if(v.confirm!==approval)throw new Fault('survey_approval_required',403)
 const recordId=text(v.callRecordId,'callRecordId'),channel=choice(v.channel,['ivr','sms'],'channel')
 const canonical=await sql(env,`SELECT r.id,r.case_id,r.data,o.source_id,o.external_id,s.account_id
  FROM hnd_records r JOIN hnd_record_sources p ON p.record_id=r.id AND p.source_kind='twilio'
  JOIN hnd_source_objects o ON o.record_id=r.id AND o.source_id=p.source_id
  JOIN hnd_sources s ON s.id=o.source_id
  WHERE r.id=? AND r.kind='call_session' AND r.case_id IS NOT NULL AND json_extract(r.data,'$.direction')='inbound'
  AND NOT EXISTS(SELECT 1 FROM hnd_records correction WHERE correction.supersedes_id=r.id)`,recordId).first<{id:string;case_id:string;data:string;source_id:string;external_id:string;account_id:string}>()
 if(!canonical)throw new Fault('verified_canonical_inbound_call_required',409)
 const data=JSON.parse(canonical.data) as Record<string,unknown>
 // Read back the exact active inbound leg; owner input never creates provider provenance.
 const call=await ensureCall(env,canonical.source_id,new URLSearchParams({AccountSid:canonical.account_id,CallSid:canonical.external_id,From:String(data.from??''),To:String(data.to??'')}))
 const {source,fences}=await policyAuthority(env,await getPolicy(env,call.policy_id))
 const existing=await sql(env,'SELECT * FROM hnd_survey_invitations WHERE call_record_id=?',recordId).first<Invitation>()
 if(existing){
  if(existing.channel!==channel)throw new Fault('survey_already_invited_on_other_channel',409)
  await commit(env,actor,'survey.read',existing.id,'completed',fences,true,sourcePolicy(source))
  return {invitation:existing,call:{id:recordId,providerCallSid:call.call_sid},case:{id:canonical.case_id},providerPath:'/providers/twilio/surveys/'+existing.id,replay:true}
 }
 const target=id(),now=Date.now()
 await commit(env,actor,'survey.create',target,'completed',[...fences,
  guard(env,"SELECT count(*) FROM hnd_records r JOIN hnd_record_sources p ON p.record_id=r.id WHERE r.id=? AND p.source_kind='twilio' AND p.source_id=? AND NOT EXISTS(SELECT 1 FROM hnd_records correction WHERE correction.supersedes_id=r.id)",recordId,source.id),
  sql(env,`INSERT INTO hnd_survey_invitations(id,call_record_id,case_id,call_id,source_id,channel,created_by,owner_version,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,target,recordId,canonical.case_id,call.id,source.id,channel,actor.operator.id,actor.operator.version,now,now+7*86400000),
 ],true,sourcePolicy(source))
 return {invitation:await sql(env,'SELECT * FROM hnd_survey_invitations WHERE id=?',target).first<Invitation>(),call:{id:recordId,providerCallSid:call.call_sid},case:{id:canonical.case_id},providerPath:'/providers/twilio/surveys/'+target,replay:false}
}
async function report(env:Bindings,actor:Session){
 await commit(env,actor,'survey.read','installation','completed')
 const counts=await sql(env,`SELECT count(*) AS invitations,
  COALESCE(sum(i.eligible_at IS NOT NULL),0) AS eligibleDelivered,
  COALESCE(sum(r.invitation_id IS NOT NULL),0) AS responses,
  COALESCE(sum(p.state='declined'),0) AS declined,
  COALESCE(sum(i.suppressed_at IS NOT NULL),0) AS suppressed,
  COALESCE(sum(r.invitation_id IS NULL AND i.expires_at<=? AND i.suppressed_at IS NULL AND COALESCE(p.state,'')!='declined'),0) AS noResponse,
  COALESCE(sum(r.invitation_id IS NULL AND i.expires_at>? AND i.suppressed_at IS NULL AND COALESCE(p.state,'')!='declined'),0) AS pending,
  avg(r.rating) AS averageRating
  FROM hnd_survey_invitations i LEFT JOIN hnd_text_permissions p ON p.id=i.permission_id LEFT JOIN hnd_survey_responses r ON r.invitation_id=i.id`,Date.now(),Date.now()).first<{invitations:number;eligibleDelivered:number;responses:number;declined:number;suppressed:number;noResponse:number;pending:number;averageRating:number|null}>()
 const rows=(await sql(env,`SELECT i.*,p.state AS permission_state,r.rating,r.comment,r.created_at AS responded_at
  FROM hnd_survey_invitations i LEFT JOIN hnd_text_permissions p ON p.id=i.permission_id LEFT JOIN hnd_survey_responses r ON r.invitation_id=i.id ORDER BY i.created_at DESC,i.id LIMIT 200`).all<Invitation&{permission_state:string|null;rating:number|null;comment:string|null;responded_at:number|null}>()).results
 return {denominators:{...counts,responseRate:counts?.eligibleDelivered?counts.responses/counts.eligibleDelivered:null,responseRateDenominator:'eligibleDelivered',averageRatingDenominator:'responses'},invitations:rows}
}
export async function surveyDoor(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response>{
 owner(actor)
 const url=new URL(request.url)
 if(url.search)throw new Fault('unexpected_survey_query')
 const native=url.pathname==='/app/surveys',api=url.pathname==='/api/handset/surveys'
 if(!native&&!api)throw new Fault('not_found',404)
 if(request.method==='POST'){
  const result=await create(env,actor,value!)
  if(!native)return json(result,result.replay?200:201)
  return page('Post-call surveys',`<p>Survey invitation created. The caller must opt in on the existing call.</p><p>Provider path: <code>${e(result.providerPath)}</code></p><p><a href="/app/records/${e(result.call.id)}">Call</a> · <a href="/app/cases/${e(result.case.id)}">Case</a> · <a href="/app/surveys">Survey report</a></p>`)
 }
 if(request.method!=='GET')throw new Fault('method_not_allowed',405)
 const result=await report(env,actor)
 if(api)return json(result)
 const d=result.denominators
 const calls=(await env.DB.prepare("SELECT r.id,r.occurred_at,r.data FROM hnd_records r JOIN hnd_source_objects o ON o.record_id=r.id WHERE r.kind='call_session' ORDER BY r.occurred_at DESC LIMIT 200").all<{id:string;occurred_at:number;data:string}>()).results
 return page('Post-call surveys',`<p>Optional customer feedback about a specific call. Each invitation keeps its first valid response.</p>
 <h2>Report</h2><dl><dt>Invitations</dt><dd>${d.invitations}</dd><dt>Eligible delivered prompts</dt><dd>${d.eligibleDelivered}</dd><dt>Responses</dt><dd>${d.responses}</dd><dt>Response rate (responses / eligible delivered)</dt><dd>${d.responseRate===null?'No eligible delivered prompts':(d.responseRate*100).toFixed(1)+'%'}</dd><dt>Average rating (responses only)</dt><dd>${d.averageRating===null?'No responses':Number(d.averageRating).toFixed(2)+' / 5'}</dd><dt>Declined</dt><dd>${d.declined}</dd><dt>Suppressed</dt><dd>${d.suppressed}</dd><dt>No response after seven days</dt><dd>${d.noResponse}</dd><dt>Pending</dt><dd>${d.pending}</dd></dl>
 <p>SMS eligibility requires independently confirmed delivery. IVR eligibility begins when the caller opts in and receives the rating prompt. Silence has no rating. Declined, suppressed and undelivered invitations do not enter the response-rate denominator.</p>
 <h2>Create invitation</h2><form method="post" action="/app/surveys"><label>Customer call<select name="callRecordId" required>${calls.map(c=>`<option value="${e(c.id)}">${e(JSON.parse(c.data).from)} · ${e(new Date(c.occurred_at).toISOString())}</option>`).join('')}</select></label><label>Channel<select name="channel"><option value="ivr">Phone keypad (1 to 5)</option><option value="sms">One survey text with optional comment</option></select></label><p>The current reviewed source and an active existing inbound call are required. The provider path presents an optional opt-in prompt after the conversation.</p>${hidden('confirm',approval)}<button>Create optional post-call survey invitation</button></form>
 <h2>Invitations (most recent 200)</h2><ol>${result.invitations.map(i=>`<li><p>${e(i.channel.toUpperCase())} · ${e(new Date(i.created_at).toISOString())} · ${i.rating!==null?'Responded: '+i.rating+' / 5':i.suppressed_at?'Suppressed: '+e(i.suppression_reason):i.permission_state==='declined'?'Declined':i.expires_at<=Date.now()?'No response':i.eligible_at?'Delivered; awaiting response':'Awaiting opt-in or confirmed delivery'}</p><p><a href="/app/records/${e(i.call_record_id)}">Call</a> · <a href="/app/cases/${e(i.case_id)}">Case</a></p>${i.comment?`<blockquote>${e(i.comment)}</blockquote>`:''}<p>Provider path: <code>/providers/twilio/surveys/${e(i.id)}</code></p></li>`).join('')||'<li>No invitations yet.</li>'}</ol>`)
}
