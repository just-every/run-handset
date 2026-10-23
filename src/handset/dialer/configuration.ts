import { mayApprove } from './authority'
import { registryChecks, stateChecks } from './compliance'
import { digest, Fault, id, integer, keys, object, text, type ObjectValue } from '../core'
import { expiry, listOf, modeList, qualificationInput, recipientInput, type ListDefinition, type QualificationDefinition, type Ready, type Recipient, type RecipientCheck } from './model'
import { currentOwner, event, evidence, guard, list, ownerGuard, qualification, sql, write, type Context } from './storage'
import { ownedFrom, waitingAgent } from './network'
import { activeSourceById, sourceFence } from '../providers/sources'
export interface Source {id:string;account_id:string;number_id:string;owner_id:string;owner_version:number;revision:number;data:string}
export async function source(ctx:Context,id:string){const row=await activeSourceById(ctx.env,id);if(!row)throw new Fault('dialer_source_unqualified',409);const record=await sql(ctx,'SELECT data FROM hnd_records WHERE id=?',row.number_id).first<{data:string}>();return {...row,data:record!.data} as Source}
export const sourceGuard=(ctx:Context,s:Source)=>sourceFence(ctx.env,s)
export async function qualify(ctx:Context,v:ObjectValue){
 const definition=qualificationInput(v),s=await source(ctx,text(v.sourceId,'sourceId')),numberSid=text(v.numberSid,'numberSid'),expiresAt=expiry(v.expiresAt),target=id()
 if(definition.jurisdictions.some(j=>!/^US-[A-Z]{2}$/.test(j)))throw new Fault('unqualified_jurisdiction')
 const fences=await Promise.all([definition.legalEvidenceId,definition.providerEvidenceId,definition.trafficEvidenceId].map(r=>evidence(ctx,r)))
 await ownedFrom(ctx,s.account_id,numberSid,JSON.parse(s.data).e164)
 await write(ctx,target,[sourceGuard(ctx,s),...fences,sql(ctx,'INSERT INTO hnd_dialer_qualifications VALUES (?,?,?,?,?,?,?,?,NULL)',target,s.id,numberSid,JSON.stringify(definition),ctx.actor!.operator.id,ctx.actor!.operator.version,Date.now(),expiresAt),event(ctx,'qualification.evidence_recorded',null,null,null,{qualificationId:target,definition,certification:'external evidence recorded; no independent legal certification claimed'})])
 return qualification(ctx,target)
}
export interface StandingDefinition {repIds:string[];purpose:string;sourceIds:string[];modes:string[];maxListSize:number;maxBudgetCents:number;attemptCents:number;ownership:'rep_owned';consent:'verified';dnc:'company_campaign_national_state';startsAt:number}
export async function standingPolicy(ctx:Context,v:ObjectValue){
 keys(v,['repIds','purpose','sourceIds','modes','maxListSize','maxBudgetCents','attemptCents','startsAt','expiresAt','confirm','queueIds'])
 if(v.confirm!=='approve exact standing CRM list policy')throw new Fault('standing_policy_approval_required',403)
 const now=Date.now(),definition:StandingDefinition={repIds:listOf(v.repIds,'repIds',100),purpose:text(v.purpose,'purpose',500),sourceIds:listOf(v.sourceIds,'sourceIds',100),modes:modeList(v.modes),maxListSize:integer(v.maxListSize,'maxListSize',1,100),maxBudgetCents:integer(v.maxBudgetCents,'maxBudgetCents',1,1000000),attemptCents:integer(v.attemptCents,'attemptCents',1,100000),ownership:'rep_owned',consent:'verified',dnc:'company_campaign_national_state',startsAt:integer(v.startsAt,'startsAt',0,now)},target=id(),expiresAt=expiry(v.expiresAt,90*86400000)
 const queueIds=v.queueIds?listOf(v.queueIds,'queueIds'): (await sql(ctx,'SELECT id FROM hnd_queues').all<{id:string}>()).results.map(q=>q.id)
 const approvalFences:D1PreparedStatement[]=[]
 for(const s of definition.sourceIds)for(const q of queueIds)approvalFences.push(await mayApprove(ctx,ctx.actor!.operator.id,ctx.actor!.operator.version,s,q,definition.maxBudgetCents,true))
 const fences=definition.repIds.map(r=>guard(ctx,"SELECT count(*) FROM oa_operators WHERE id=? AND status='active'",r))
 for(const r of definition.sourceIds)fences.push(sourceGuard(ctx,await source(ctx,r)))
 await write(ctx,target,[...fences,...approvalFences,sql(ctx,'INSERT INTO hnd_dialer_policies VALUES (?,?,?,?,1,?,?,NULL)',target,JSON.stringify({...definition,queueIds}),ctx.actor!.operator.id,ctx.actor!.operator.version,now,expiresAt),event(ctx,'policy.approved',null,null,null,{policyId:target,revision:1,definition})]);return {id:target,revision:1,definition}
}
export async function approveList(ctx:Context,v:ObjectValue){
 keys(v,['name','purpose','sourceId','queueId','qualificationId','repId','budgetCents','attemptCents','maxConcurrency','modes','recipients','policyId','expiresAt','confirm'])
 const policyId=v.policyId?text(v.policyId,'policyId'):null
 if(v.confirm!==(policyId?'snapshot list under exact standing policy':'approve exact campaign list and budget'))throw new Fault('exact_list_approval_required',403)
 if(!Array.isArray(v.recipients)||!v.recipients.length||v.recipients.length>100)throw new Fault('invalid_recipients')
 const rows=v.recipients.map(recipientInput),s=await source(ctx,text(v.sourceId,'sourceId')),q=await qualification(ctx,text(v.qualificationId,'qualificationId')),purpose=text(v.purpose,'purpose',500),queueId=text(v.queueId,'queueId'),expiresAt=expiry(v.expiresAt),now=Date.now()
 if(q.source_id!==s.id||q.revoked_at||q.expires_at<expiresAt||!await currentOwner(ctx,q.approved_by,q.owner_version))throw new Fault('qualification_not_current',409)
 const qualified=JSON.parse(q.definition) as QualificationDefinition
 const definition:ListDefinition={repId:text(v.repId,'repId'),budgetCents:integer(v.budgetCents,'budgetCents',1,1000000),attemptCents:integer(v.attemptCents,'attemptCents',1,100000),maxConcurrency:integer(v.maxConcurrency,'maxConcurrency',1,10),from:JSON.parse(s.data).e164,modes:modeList(v.modes)}
 if(definition.modes.some(m=>!qualified.modes.includes(m))||definition.maxConcurrency>qualified.maxConcurrency)throw new Fault('list_outside_qualification',409)
 let approver=ctx.actor!.operator.id,ownerVersion=ctx.actor!.operator.version,policyRevision:number|null=null
 const approval=await mayApprove(ctx,ctx.actor!.operator.id,ctx.actor!.operator.version,s.id,queueId,definition.budgetCents)
 const fences=[approval,sourceGuard(ctx,s),ownerGuard(ctx,q.approved_by,q.owner_version),guard(ctx,'SELECT count(*) FROM hnd_dialer_qualifications WHERE id=? AND revoked_at IS NULL AND expires_at>=?',q.id,expiresAt),guard(ctx,'SELECT count(*) FROM hnd_queues WHERE id=?',queueId),guard(ctx,"SELECT count(*) FROM oa_operators WHERE id=? AND status='active'",definition.repId)]
 if(policyId){
  const p=await sql(ctx,'SELECT * FROM hnd_dialer_policies WHERE id=? AND revoked_at IS NULL AND expires_at>=?',policyId,expiresAt).first<{definition:string;revision:number;approved_by:string;owner_version:number}>();if(!p)throw new Fault('standing_policy_revoked',409)
  const b=JSON.parse(p.definition) as StandingDefinition&{queueIds?:string[]}
  const policyAuthority=await mayApprove(ctx,p.approved_by,p.owner_version,s.id,queueId,definition.budgetCents,true)
  if(b.queueIds&&!b.queueIds.includes(queueId))throw new Fault('list_outside_standing_policy',409)
  if(!b.repIds.includes(definition.repId)||!b.sourceIds.includes(s.id)||b.purpose!==purpose||rows.length>b.maxListSize||definition.budgetCents>b.maxBudgetCents||definition.attemptCents!==b.attemptCents||definition.modes.some(m=>!b.modes.includes(m))||b.startsAt>now)throw new Fault('list_outside_standing_policy',409)
  approver=p.approved_by;ownerVersion=p.owner_version;policyRevision=p.revision
  fences.push(policyAuthority,guard(ctx,'SELECT count(*) FROM hnd_dialer_policies WHERE id=? AND revision=? AND revoked_at IS NULL AND expires_at>=?',policyId,policyRevision,expiresAt))
 }
 if(new Set(rows.map(r=>r.recipient)).size!==rows.length)throw new Fault('duplicate_recipient')
 for(const r of rows){
  fences.push(...await registryChecks(ctx,s.number_id,r.recipient,r.definition))
  for(const mode of definition.modes)fences.push(...await stateChecks(ctx,r.recipient,r.definition,mode,false))
  if(!qualified.jurisdictions.includes(r.definition.jurisdiction))throw new Fault('recipient_outside_qualification',409)
  const c=await sql(ctx,'SELECT owner_id FROM hnd_cases WHERE id=?',r.caseId).first<{owner_id:string}>()
  if(!c||policyId&&c.owner_id!==definition.repId)throw new Fault('outside_crm_owner',409)
  fences.push(guard(ctx,'SELECT count(*) FROM hnd_cases WHERE id=? AND owner_id=?',r.caseId,c.owner_id),guard(ctx,"SELECT count(*) FROM hnd_records WHERE id=? AND kind='person' AND case_id=?",r.personId,r.caseId))
  const consent=await sql(ctx,"SELECT * FROM hnd_records WHERE id=? AND kind='consent' AND case_id=? AND parent_id=?",r.definition.consentId,r.caseId,r.personId).first<{data:string}>()
  if(!consent||JSON.parse(consent.data).purpose!==purpose)throw new Fault('recipient_consent_record_required',409)
 }
 const target=id(),snapshotHash=await digest({purpose,sourceId:s.id,queueId,qualificationId:q.id,definition,recipients:rows,policyId,policyRevision,expiresAt})
 await write(ctx,target,[...fences,sql(ctx,'INSERT INTO hnd_dialer_lists VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,0)',target,text(v.name,'name',120),purpose,s.id,queueId,q.id,JSON.stringify(definition),snapshotHash,approver,ownerVersion,policyId,policyRevision,now,expiresAt),...rows.map((r,n)=>sql(ctx,'INSERT INTO hnd_dialer_recipients VALUES (?,?,?,?,?,?)',target,n,r.caseId,r.personId,r.recipient,JSON.stringify(r.definition))),event(ctx,policyId?'list.policy_approved':'list.person_approved',target,null,null,{snapshotHash,approver,policyId,policyRevision,size:rows.length,definition})])
 return list(ctx,target)
}
export async function recipientCheck(ctx:Context,listId:string,ordinal:number,v:ObjectValue){
 keys(v,['consentEvidenceId','company','national','state','campaign','purpose','methods','expiresAt','confirm'])
 if(v.confirm!=='verify exact recipient consent and current suppression checks')throw new Fault('recipient_verification_required',403)
 const l=await list(ctx,listId),row=await sql(ctx,'SELECT * FROM hnd_dialer_recipients WHERE list_id=? AND ordinal=?',l.id,ordinal).first<Recipient>();if(!row)throw new Fault('recipient_not_found',404)
 const definition:RecipientCheck={consentEvidenceId:text(v.consentEvidenceId,'consentEvidenceId'),company:text(v.company,'company'),national:text(v.national,'national'),state:text(v.state,'state'),campaign:text(v.campaign,'campaign'),purpose:text(v.purpose,'purpose',500),methods:listOf(v.methods,'methods',5)}
 if(definition.purpose!==l.purpose||definition.methods.some(m=>!JSON.parse(l.definition).modes.includes(m)))throw new Fault('recipient_check_scope_mismatch')
 for(const scope of ['company','national','state','campaign'] as const)if(!['clear','blocked','unknown'].includes(definition[scope]))throw new Fault('invalid_dnc_state')
 const target=id(),expiresAt=expiry(v.expiresAt,86400000),fence=await evidence(ctx,definition.consentEvidenceId)
 await write(ctx,l.id,[fence,sql(ctx,'INSERT INTO hnd_dialer_checks VALUES (?,?,?,?,?,?,?,?)',target,l.id,ordinal,JSON.stringify(definition),ctx.actor!.operator.id,ctx.actor!.operator.version,Date.now(),expiresAt),event(ctx,'recipient.verified',l.id,null,null,{ordinal,checkId:target,definition,expiresAt})]);return {id:target,expiresAt}
}
export async function readyAgent(ctx:Context,v:ObjectValue){
 keys(v,['agentId','sourceId','conferenceSid','conferenceName','agentCallSid','expiresAt','confirm'])
 if(v.confirm!=='reserve this independently connected waiting agent')throw new Fault('waiting_agent_approval_required',403)
 const s=await source(ctx,text(v.sourceId,'sourceId')),agentId=text(v.agentId,'agentId')
 if(ctx.actor!.operator.role!=='owner'&&ctx.actor!.operator.id!==agentId)throw new Fault('self_service_only',403)
 const route=await sql(ctx,"SELECT * FROM hnd_queue_agent_routes WHERE operator_id=? AND source_id=? AND revoked_at IS NULL",agentId,s.id).first<{destination:string;approved_by:string;owner_version:number}>()
 if(!route||!await sql(ctx,"SELECT id FROM oa_operators WHERE id=? AND role='owner' AND status='active'",route.approved_by).first())throw new Fault('agent_route_unqualified',409)
 if(await sql(ctx,'SELECT attempt_id FROM hnd_dialer_reservations WHERE agent_id=?',agentId).first())throw new Fault('agent_has_unresolved_call',409)
 const ready:Ready={agent_id:agentId,source_id:s.id,conference_sid:text(v.conferenceSid,'conferenceSid'),conference_name:text(v.conferenceName,'conferenceName'),agent_call_sid:text(v.agentCallSid,'agentCallSid'),approved_by:ctx.actor!.operator.id,owner_version:ctx.actor!.operator.version,observed_at:Date.now(),expires_at:expiry(v.expiresAt,90000)}
 await waitingAgent(ctx,s.account_id,ready,route.destination)
 await write(ctx,'installation',[sourceGuard(ctx,s),guard(ctx,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_dialer_reservations WHERE agent_id=?) THEN 0 ELSE 1 END',agentId),sql(ctx,`INSERT INTO hnd_dialer_ready VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET source_id=excluded.source_id,conference_sid=excluded.conference_sid,conference_name=excluded.conference_name,agent_call_sid=excluded.agent_call_sid,approved_by=excluded.approved_by,owner_version=excluded.owner_version,observed_at=excluded.observed_at,expires_at=excluded.expires_at`,...Object.values(ready)),event(ctx,'agent.waiting_media_verified',null,null,null,{agentId,conferenceSid:ready.conference_sid,expiresAt:ready.expires_at})]);return ready
}
export async function revoke(ctx:Context,kind:'lists'|'qualifications'|'policies',target:string){await write(ctx,target,[sql(ctx,'UPDATE hnd_dialer_'+kind+' SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',Date.now(),target),event(ctx,kind+'.revoked',kind==='lists'?target:null,null,null,{target}),sql(ctx,"UPDATE hnd_dialer_sessions SET state='paused',reason='approval_revoked',revision=revision+1 WHERE state='running' AND list_id IN (SELECT id FROM hnd_dialer_lists WHERE "+(kind==='lists'?'id':kind==='policies'?'policy_id':'qualification_id')+'=?)',target)]);return {revoked:true,connectedCallsPreserved:true}}
