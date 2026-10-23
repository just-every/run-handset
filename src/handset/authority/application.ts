import type { Bindings } from '../../auth.server'
import { runtimeBindings } from '../../auth.server'
import { digest, Fault, id, input, json, keys, object, text, type ObjectValue } from '../core'
import { append } from '../audit/store'
import type { AppliedPolicy } from '../audit/policy'
import { getCase } from '../records/store'
import { scopeFor, state, type State, type Definition, type Bounds, type Tool } from './model'
import { checkState, grantFence, grantPolicy, policyMatches, type Grant, type Approval, type Standing, type Job } from './store'

export { grantFence } from './store'
export async function applicationAuth(request:Request,env:Bindings,applied:AppliedPolicy={}):Promise<Grant>{
 const authorization=request.headers.get('authorization')
 if(!authorization||!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))throw new Fault('application_credential_required',401)
 const hash=await digest(authorization.slice(7))
 const grant=await env.DB.prepare('SELECT * FROM hnd_grants WHERE token_hash=?').bind(hash).first<Grant>()
 if(!grant)throw new Fault('application_credential_inactive',401)
 Object.assign(applied,grantPolicy(grant))
 if(grant.revoked_at||grant.expires_at<=Date.now()||!await env.DB.prepare("SELECT id FROM oa_operators WHERE id=? AND status='active' AND role='owner' AND version=?").bind(grant.created_by,grant.owner_version).first())throw new Fault('application_credential_inactive',401)
 return grant
}
async function applicationRead(env:Bindings,g:Grant,caseId:string){
 const d=JSON.parse(g.definition) as Definition
 if(!d.scopes.includes('read')||!d.tools.includes('case.read')||!d.records.includes(caseId))throw new Fault('record_out_of_scope',403)
 const detail=await getCase(env.DB,caseId)
 await append(env,g.id,'application.read',caseId,'completed',[grantFence(env,g)],null,grantPolicy(g))
 return detail
}
async function draft(env:Bindings,g:Grant,value:ObjectValue){
 keys(value,['caseId','text'])
 const caseId=text(value.caseId,'caseId'),content=text(value.text,'text',4000),d=JSON.parse(g.definition) as Definition
 if(!d.scopes.includes('draft')||!d.tools.includes('comment.draft')||!d.records.includes(caseId))throw new Fault('draft_out_of_scope',403)
 await getCase(env.DB,caseId)
 const draftId=id()
 await append(env,g.id,'application.draft',caseId,'completed',[
  grantFence(env,g),env.DB.prepare('INSERT INTO hnd_drafts VALUES (?,?,?,?,?)').bind(draftId,g.id,caseId,content,Date.now()),
 ],null,grantPolicy(g))
 return {id:draftId,status:'draft',published:false}
}
async function authority(env:Bindings,g:Grant,s:State,value:ObjectValue,applied:AppliedPolicy){
 if(value.approvalId){
  const approval=await env.DB.prepare('SELECT * FROM hnd_approvals WHERE id=? AND grant_id=?').bind(text(value.approvalId,'approvalId'),g.id).first<Approval>()
  if(approval)applied.approval={id:approval.id,revision:1,ownerVersion:approval.owner_version}
  if(!approval||approval.revoked_at||approval.expires_at<=Date.now()||approval.grant_revision!==g.revision||approval.state_hash!==await digest(s)||approval.consumed_by)throw new Fault('exact_approval_required',403)
  const fence=env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_approvals a JOIN oa_operators o ON o.id=a.approved_by WHERE a.id=? AND a.grant_id=? AND a.grant_revision=? AND a.state_hash=? AND a.revoked_at IS NULL AND a.expires_at>? AND a.consumed_by IS NULL AND o.status='active' AND o.role='owner' AND o.version=a.owner_version AND a.owner_version=?`).bind(approval.id,g.id,g.revision,approval.state_hash,Date.now(),approval.owner_version)
  return {approvedBy:approval.approved_by,ownerVersion:approval.owner_version,approvalId:approval.id,standingId:null,standingRevision:null,fence}
 }
 if(value.standingId){
  const standing=await env.DB.prepare('SELECT * FROM hnd_standing WHERE id=? AND grant_id=?').bind(text(value.standingId,'standingId'),g.id).first<Standing>()
  if(standing)applied.standing={id:standing.id,revision:standing.revision,ownerVersion:standing.owner_version}
  if(!standing||standing.revoked_at||standing.expires_at<=Date.now()||!policyMatches(JSON.parse(standing.bounds) as Bounds,s))throw new Fault('standing_snapshot_out_of_bounds',403)
  const fence=env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_standing p JOIN oa_operators o ON o.id=p.approved_by WHERE p.id=? AND p.revision=? AND p.owner_version=? AND p.revoked_at IS NULL AND p.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=p.owner_version`).bind(standing.id,standing.revision,standing.owner_version,Date.now())
  return {approvedBy:standing.approved_by,ownerVersion:standing.owner_version,approvalId:null,standingId:standing.id,standingRevision:standing.revision,fence}
 }
 throw new Fault('exact_human_approval_required',403)
}
function jobPolicy(job:Job,applied:AppliedPolicy){
 if(job.standing_id)applied.standing={id:job.standing_id,revision:job.standing_revision!,ownerVersion:job.approved_owner_version}
 else if(job.approval_id)applied.approval={id:job.approval_id,revision:1,ownerVersion:job.approved_owner_version}
}
async function prepare(env:Bindings,g:Grant,value:ObjectValue,applied:AppliedPolicy){
 keys(value,['state','approvalId','standingId','idempotencyKey','callerInstructions'])
 // Caller content is inert data; it is never parsed as a grant or approval.
 if(value.callerInstructions!==undefined)text(value.callerInstructions,'callerInstructions',4000,true)
 if(value.approvalId&&value.standingId)throw new Fault('one_approval_basis_required')
 const s=state(value.state),d=await checkState(env,g,s),key=text(value.idempotencyKey,'idempotencyKey',100),hash=await digest(s)
 if(['case.read','comment.draft'].includes(s.operation))throw new Fault('use_read_or_draft_door')
 if(['number.port','recording.read','commitment.make'].includes(s.operation))throw new Fault('qualified_human_or_media_door_required',403)
 const existing=await env.DB.prepare('SELECT * FROM hnd_jobs WHERE grant_id=? AND idempotency_key=?').bind(g.id,key).first<Job>()
 if(existing){jobPolicy(existing,applied);if(existing.state_hash!==hash)throw new Fault('idempotency_state_changed',409);await append(env,g.id,'application.read',existing.id,'completed',[grantFence(env,g)],null,applied);return {job:existing,replay:true,effectOccurred:false}}
 const a=await authority(env,g,s,value,applied),jobId=id(),now=Date.now()
 await append(env,g.id,'application.attempt',jobId,'completed',[
  grantFence(env,g),a.fence,
  env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_cases WHERE id=? AND version=?').bind(s.caseId,s.caseVersion),
  env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_grants WHERE id=? AND reserved_cents+?<=?').bind(g.id,s.amountCents,d.budgetCents),
  env.DB.prepare('UPDATE hnd_grants SET reserved_cents=reserved_cents+? WHERE id=?').bind(s.amountCents,g.id),
  env.DB.prepare('INSERT INTO hnd_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(jobId,g.id,g.revision,key,hash,JSON.stringify(s),a.approvalId,a.standingId,a.standingRevision,a.approvedBy,a.ownerVersion,'held_adapter_unqualified',s.amountCents,now),
  ...(a.approvalId?[env.DB.prepare('UPDATE hnd_approvals SET consumed_by=? WHERE id=? AND consumed_by IS NULL').bind(jobId,a.approvalId)]:[]),
 ],null,applied)
 return {job:await env.DB.prepare('SELECT * FROM hnd_jobs WHERE id=?').bind(jobId).first(),replay:false,effectOccurred:false}
}
async function execute(env:Bindings,g:Grant,value:ObjectValue,applied:AppliedPolicy){
 keys(value,['jobId','state'])
 const job=await env.DB.prepare('SELECT * FROM hnd_jobs WHERE id=? AND grant_id=?').bind(text(value.jobId,'jobId'),g.id).first<Job>()
 if(job)jobPolicy(job,applied)
 if(!job||job.status!=='held_adapter_unqualified'||job.grant_revision!==g.revision)throw new Fault('job_inactive',403)
 const s=state(value.state)
 if(await digest(s)!==job.state_hash)throw new Fault('reviewed_state_changed',409)
 await checkState(env,g,s)
 let approvalFence:D1PreparedStatement
 if(job.standing_id){
  const p=await env.DB.prepare('SELECT * FROM hnd_standing WHERE id=?').bind(job.standing_id).first<Standing>()
  if(!p||p.revision!==job.standing_revision||p.owner_version!==job.approved_owner_version||!policyMatches(JSON.parse(p.bounds),s))throw new Fault('standing_policy_changed',409)
  approvalFence=env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_standing p JOIN oa_operators o ON o.id=p.approved_by WHERE p.id=? AND p.revision=? AND p.owner_version=? AND p.revoked_at IS NULL AND p.expires_at>? AND o.role='owner' AND o.status='active' AND o.version=p.owner_version`).bind(p.id,p.revision,p.owner_version,Date.now())
 }else{
  approvalFence=env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_approvals a JOIN oa_operators o ON o.id=a.approved_by WHERE a.id=? AND a.consumed_by=? AND a.grant_id=? AND a.grant_revision=? AND a.state_hash=? AND a.owner_version=? AND a.revoked_at IS NULL AND a.expires_at>? AND o.role='owner' AND o.status='active' AND o.version=a.owner_version`).bind(job.approval_id,job.id,g.id,job.grant_revision,job.state_hash,job.approved_owner_version,Date.now())
 }
 await append(env,g.id,'application.execute',job.id,'refused',[
  grantFence(env,g),approvalFence,env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_cases WHERE id=? AND version=?').bind(s.caseId,s.caseVersion),
 ],null,applied)
 // No qualified provider exists yet. This is never a successful paid effect.
 return {status:'held_adapter_unqualified',effectOccurred:false,jobId:job.id}
}
async function mcp(env:Bindings,g:Grant,value:ObjectValue,applied:AppliedPolicy){
 keys(value,['jsonrpc','id','method','params'])
 if(value.jsonrpc!=='2.0'||!['string','number'].includes(typeof value.id))throw new Fault('invalid_mcp_request')
 const method=text(value.method,'method'),params=value.params===undefined?{}:object(value.params)
 if(method==='initialize')return {protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'handset-scoped-work',version:'1'}}
 const d=JSON.parse(g.definition) as Definition
 if(method==='tools/list')return {tools:d.tools.map(name=>({name,description:name==='case.read'?'Read a selected native case':name==='comment.draft'?'Create an unpublished draft':'Prepare reviewed work; qualified adapter required',inputSchema:{type:'object'}}))}
 if(method!=='tools/call')throw new Fault('unsupported_mcp_method',404)
 keys(params,['name','arguments'])
 const name=text(params.name,'name') as Tool,args=object(params.arguments)
 if(!d.tools.includes(name)||!d.scopes.includes(scopeFor(name)))throw new Fault('tool_out_of_scope',403)
 if(name==='case.read'){keys(args,['caseId']);return applicationRead(env,g,text(args.caseId,'caseId'))}
 if(name==='comment.draft')return draft(env,g,args)
 const proposed=state(args.state)
 if(proposed.operation!==name)throw new Fault('tool_operation_mismatch',403)
 return prepare(env,g,args,applied)
}
export async function applicationResponse(request:Request,original:Bindings):Promise<Response|null>{
 const url=new URL(request.url)
 if(!/^\/api\/handset\/application(?:\/|$)/.test(url.pathname))return null
 const env=runtimeBindings(original)
 let grant:Grant|undefined
 const applied:AppliedPolicy={}
 try{
  if(url.origin!==env.AUTH_ORIGIN||request.headers.has('host')&&request.headers.get('host')?.toLowerCase()!==url.host.toLowerCase())throw new Fault('invalid_host',403)
  if(request.headers.has('origin')&&request.headers.get('origin')!==env.AUTH_ORIGIN||request.headers.get('sec-fetch-site')==='cross-site')throw new Fault('invalid_origin',403)
  grant=await applicationAuth(request,env,applied)
  const base='/api/handset/application',path=url.pathname
  const read=path.match(/^\/api\/handset\/application\/cases\/([^/]+)$/)
  if(request.method==='GET'&&read)return json(await applicationRead(env,grant,read[1]))
  if(request.method!=='POST')throw new Fault('method_not_allowed',405)
  const data=await input(request)
  if(path===base+'/drafts')return json(await draft(env,grant,data),201)
  if(path===base+'/prepare')return json(await prepare(env,grant,data,applied),202)
  if(path===base+'/execute')return json(await execute(env,grant,data,applied),202)
  if(path===base+'/mcp'){const result=await mcp(env,grant,data,applied);await append(env,grant.id,'application.read','installation','completed',[grantFence(env,grant)],null,applied);return json({jsonrpc:'2.0',id:data.id,result})}
  throw new Fault('not_found',404)
 }catch(error){
  if(error instanceof Fault){await append(env,grant?.id??applied.grant?.id??'anonymous','application.attempt','installation','refused',[],null,applied);return json({error:error.code},error.status)}
  if(String(error).includes('CHECK constraint failed'))return json({error:'authority_or_budget_changed'},409)
  if(String(error).includes('UNIQUE constraint failed: hnd_jobs'))return json({error:'job_conflict_retry'},409)
  console.error('Handset application request failed',error instanceof Error?error.name:'unknown')
  return json({error:'store_unavailable'},503)
 }
}
