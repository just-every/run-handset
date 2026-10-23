import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { json, page, escape as e, field, hidden, keys, text, object, Fault, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import { issue, rotateCredential, revokeAuthority, revokeGrant, grantById, approve, writeStanding, type Grant } from './store'
import { state } from './model'

const parse=(value:unknown)=>{if(typeof value!=='string')return object(value);try{return object(JSON.parse(value))}catch{throw new Fault('invalid_review_json')}}
const csv=(value:unknown)=>typeof value==='string'?value.split(',').map(x=>x.trim()).filter(Boolean):[]
const redirect=()=>new Response(null,{status:303,headers:{location:'/app/grants','cache-control':'no-store'}})
export async function grantsPage(env:Bindings){
 const grants=(await env.DB.prepare('SELECT id,name,definition,revision,created_by,owner_version,expires_at,revoked_at,reserved_cents,created_at,credential_expires_at,credential_revision FROM hnd_grants ORDER BY created_at DESC').all<Grant>()).results
 const jobs=(await env.DB.prepare('SELECT * FROM hnd_jobs ORDER BY created_at DESC LIMIT 100').all()).results
 const approvals=(await env.DB.prepare('SELECT id,grant_id,state_json,approved_by,revoked_at,expires_at FROM hnd_approvals ORDER BY created_at DESC LIMIT 100').all()).results
 const policies=(await env.DB.prepare('SELECT id,grant_id,bounds,revision,approved_by,revoked_at,expires_at FROM hnd_standing ORDER BY created_at DESC LIMIT 100').all()).results
 const authorities=(kind: 'approval' | 'policy', rows: Record<string, unknown>[])=>`<ul>${rows.map(a=>`<li><p>${e(a.id)} · Grant ${e(a.grant_id)} · Human ${e(a.approved_by)} · ${a.revoked_at?'Revoked':Number(a.expires_at)<=Date.now()?'Expired':'Active'}</p><p>${e(a.state_json??a.bounds)}</p>${!a.revoked_at?`<form method="post" action="/app/grants/${kind}/${e(a.id)}/revoke"><button>Revoke ${kind} ${e(a.id)}</button></form>`:''}</li>`).join('')||'<li>None recorded.</li>'}</ul>`
 const drafts=(await env.DB.prepare('SELECT * FROM hnd_drafts ORDER BY created_at DESC LIMIT 100').all()).results
 return page('Application grants',`<p>Explicit owner consent / Consentimiento del propietario. Applications never inherit a human session. External effects remain held until qualified adapters exist.</p><h2>Current credentials</h2><ul>${grants.map(g=>`<li><strong>${e(g.name)}</strong><p>${e(g.id)} · Revision ${g.revision} · ${g.revoked_at?'Revoked':g.expires_at<=Date.now()?'Expired':'Active'} · Reserved USD ${(g.reserved_cents/100).toFixed(2)}</p><p>${e(g.definition)}</p><p>Review due ${e(new Date(g.expires_at).toISOString())} · Secret ${g.credential_expires_at<=Date.now()?'expired':'expires '+e(new Date(g.credential_expires_at).toISOString())} · Secret revision ${g.credential_revision}</p>${!g.revoked_at&&g.expires_at>Date.now()?`<form method="post" action="/app/grants/${e(g.id)}/rotate"><button>Rotate credential ${e(g.name)}</button></form>`:''}${!g.revoked_at?`<form method="post" action="/app/grants/${e(g.id)}/revoke"><button>Revoke ${e(g.name)}</button></form>`:''}</li>`).join('')||'<li>No application credentials.</li>'}</ul><h2>Issue scoped credential</h2><p>Case, number and recipient selections use native record IDs. Empty selections grant no access.</p><form method="post" action="/app/grants/create">${field('Application name','name')}<label>Permission preset<select name="mode"><option value="read">Read-only</option><option value="draft">Draft-only</option><option value="receptionist">Bounded receptionist</option></select></label>${field('Selected case IDs, comma separated','records')}${field('Selected number IDs, comma separated','numbers','','text',false)}${field('Selected person recipient IDs, comma separated','recipients','','text',false)}${field('Budget in USD cents','budgetCents','0','number')}${field('Policy revision','policyRevision','owner-only-v1')}${field('Review due at (UTC, within 90 days)','expiresAt',new Date(Date.now()+3600000).toISOString().slice(0,16),'datetime-local')}<label><input type="checkbox" name="confirm" value="approve scoped credential" required>I approve these exact scopes and selections</label><button>Issue credential</button></form><p><a href="/app/grants/consent">MCP owner consent</a></p><h2>Review exact work</h2><p>Paste the proposed state. The next screen displays every input before approval. Ports require a human attestation door and cannot be signed by an application.</p><form method="post" action="/app/grants/review">${field('Grant ID','grantId')}${field('Proposed state JSON','state')}${field('Approval expires at (UTC)','expiresAt',new Date(Date.now()+1800000).toISOString().slice(0,16),'datetime-local')}<button>Review proposed work</button></form><h2>Standing call policy</h2><p>Only in-bounds paid-call list snapshots can use standing authority. New campaigns always require exact human approval.</p><form method="post" action="/app/grants/policy">${field('Standing grant ID','grantId')}${field('Bounds JSON','bounds')}${field('Standing expiry UTC','expiresAt',new Date(Date.now()+1800000).toISOString().slice(0,16),'datetime-local')}<label><input type="checkbox" name="confirm" value="approve standing call bounds" required>I approve these standing call bounds</label><button>Approve standing bounds</button></form><h2>Exact approvals</h2>${authorities('approval',approvals)}<h2>Standing policies</h2>${authorities('policy',policies)}<h2>Held and cancelled work</h2><ul>${jobs.map(j=>`<li><p>${e(j.id)} · ${e(j.status)} · Human ${e(j.approved_by)} · Standing revision ${e(j.standing_revision)}</p><p>${e(j.state_json)}</p>${j.status==='held_adapter_unqualified'?`<form method="post" action="/app/grants/jobs/${e(j.id)}/cancel"><button>Cancel held job ${e(j.id)}</button></form>`:''}</li>`).join('')||'<li>No jobs.</li>'}</ul><h2>Unpublished drafts</h2><ul>${drafts.map(d=>`<li>${e(d.text)}<p>Application ${e(d.grant_id)} · Case ${e(d.case_id)}</p></li>`).join('')||'<li>No drafts.</li>'}</ul>`)
}
export async function authorityDoor(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response|null>{
 const path=new URL(request.url).pathname,html=path.startsWith('/app/'),read=request.method==='GET'
 const consent=['/api/handset/mcp/consent','/app/grants/consent'].includes(path)
 if(consent&&read){await commit(env,actor,'grant.read','installation','completed');return page('MCP owner consent','<p>Only a signed-in owner can issue explicit scoped application credentials. MCP callers cannot approve themselves or reuse a human session.</p><a href="/app/grants">Review scopes and issue a credential</a>')}
 if(consent&&value){const result=await issue(env,actor,value);await commit(env,actor,'grant.consent',result.grant.id,'completed');return json(result,201)}
 if(!/^\/(api\/handset|app)\/grants(?:\/|$)/.test(path))return null
 const base=html?'/app/grants':'/api/handset/grants'
 if(read&&path===base){await commit(env,actor,'grant.read','installation','completed');return html?grantsPage(env):json({grants:(await env.DB.prepare('SELECT id,name,definition,revision,created_by,owner_version,expires_at,revoked_at,reserved_cents,created_at,credential_expires_at,credential_revision FROM hnd_grants ORDER BY created_at DESC').all()).results})}
 if(!read&&value&&(path===base||path===base+'/create')){
  let data=value
  if(html){
   keys(value,['name','mode','records','numbers','recipients','budgetCents','policyRevision','expiresAt','confirm'])
   if(!['read','draft','receptionist'].includes(String(value.mode)))throw new Fault('invalid_preset')
   const mode=value.mode
   data={name:value.name,definition:{scopes:mode==='read'?['read']:mode==='draft'?['draft']:['read','draft','send'],tools:mode==='read'?['case.read']:mode==='draft'?['comment.draft']:['case.read','comment.draft','call.paid','message.send'],records:csv(value.records),numbers:csv(value.numbers),recipients:csv(value.recipients),budgetCents:Number(value.budgetCents),policyRevision:value.policyRevision},expiresAt:new Date(String(value.expiresAt)+'Z').getTime(),confirm:value.confirm}
  }
  const result=await issue(env,actor,data)
  return html?page('Credential issued',`<p>Copy this credential once into the application’s private settings. It will not be shown again. Do not place it in URLs, screenshots or messages.</p><code>${e(result.token)}</code><p>Grant ID ${e(result.grant.id)}</p><a href="/app/grants">Return to application grants</a>`):json(result,201)
 }
 if(!read&&value&&path===base+'/review'){
  keys(value,['grantId','state','expiresAt'])
  const reviewed=state(parse(value.state)),grantId=text(value.grantId,'grantId')
  await grantById(env.DB,grantId)
  return page('Approve exact work',`<p>Review every input. Changes to price, recipients, policy, flow revision or case version require fresh approval.</p><dl>${Object.entries(reviewed).map(([key,value])=>`<dt>${e(key)}</dt><dd>${e(JSON.stringify(value))}</dd>`).join('')}</dl><form method="post" action="/app/grants/approve">${hidden('grantId',grantId)}${hidden('state',JSON.stringify(reviewed))}${hidden('expiresAt',value.expiresAt)}<label><input type="checkbox" name="confirm" value="approve exact reviewed state" required>I approve this exact reviewed work</label><button>Approve exact work</button></form>`)
 }
 if(!read&&value&&path===base+'/approve'){
  const data={...value,state:parse(value.state),...(html?{expiresAt:new Date(String(value.expiresAt)+'Z').getTime()}:{})}
  const result=await approve(env,actor,data)
  return html?page('Exact approval recorded',`<p>Approval ${e(result.id)}</p><p>State hash ${e(result.stateHash)}</p><a href="/app/grants">Return to grants</a>`):json(result,201)
 }
 if(!read&&value&&path===base+'/policy'){
  const data={...value,bounds:parse(value.bounds),...(html?{expiresAt:new Date(String(value.expiresAt)+'Z').getTime()}:{})},result=await writeStanding(env,actor,data)
  return html?page('Standing bounds approved',`<p>Policy ${e(result.id)} · Revision ${result.revision}</p><a href="/app/grants">Return to grants</a>`):json(result,201)
 }
 const revise=path.match(/^\/api\/handset\/grants\/policy\/([^/]+)\/revise$/)
 if(revise&&value&&!read)return json(await writeStanding(env,actor,value,revise[1]),201)
 const rotation=path.match(/^\/(?:app|api\/handset)\/grants\/([^/]+)\/rotate$/)
 if(rotation&&!read){
  const result=await rotateCredential(env,actor,rotation[1])
  return html?page('Credential rotated',`<p>Copy this credential once into the application's private settings. The previous credential is inactive. The reviewed scopes and approvals are unchanged.</p><code>${e(result.token)}</code><a href="/app/grants">Return to application grants</a>`):json(result,201)
 }
 const individual=path.match(/^\/(?:app|api\/handset)\/grants\/(approval|policy)\/([^/]+)\/revoke$/)
 if(individual&&!read){const result=await revokeAuthority(env,actor,individual[1] as 'approval' | 'policy',individual[2]);return html?redirect():json(result)}
 const revoke=path.match(/^\/(?:app|api\/handset)\/grants\/([^/]+)\/revoke$/)
 if(revoke&&!read){const result=await revokeGrant(env,actor,revoke[1]);return html?redirect():json(result)}
 const cancel=path.match(/^\/(?:app|api\/handset)\/grants\/jobs\/([^/]+)\/cancel$/)
 if(cancel&&!read){
  const job=await env.DB.prepare('SELECT grant_id,amount_cents FROM hnd_jobs WHERE id=? AND status=?').bind(cancel[1],'held_adapter_unqualified').first<{grant_id:string;amount_cents:number}>()
  if(!job)throw new Fault('job_not_held',409)
  await commit(env,actor,'approval.revoke',cancel[1],'completed',[
   env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_jobs WHERE id=? AND status='held_adapter_unqualified'").bind(cancel[1]),
   env.DB.prepare("UPDATE hnd_jobs SET status='cancelled' WHERE id=?").bind(cancel[1]),
   env.DB.prepare('UPDATE hnd_grants SET reserved_cents=reserved_cents-? WHERE id=?').bind(job.amount_cents,job.grant_id),
  ])
  return html?redirect():json({cancelled:true})
 }
 return null
}
