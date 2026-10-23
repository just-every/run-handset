import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { id, digest, Fault, text, keys, object, integer, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import type { AppliedPolicy } from '../audit/policy'
import { definition, expires, state, bounds, type Definition, type State, type Bounds } from './model'
import { getCase } from '../records/store'
export interface Grant {id:string;name:string;definition:string;revision:number;created_by:string;owner_version:number;expires_at:number;revoked_at:number|null;reserved_cents:number;created_at:number}
export interface Approval {id:string;grant_id:string;grant_revision:number;state_hash:string;state_json:string;approved_by:string;owner_version:number;expires_at:number;consumed_by:string|null;revoked_at:number|null}
export interface Standing {id:string;grant_id:string;revision:number;bounds:string;approved_by:string;owner_version:number;expires_at:number;revoked_at:number|null}
export interface Job {id:string;grant_id:string;grant_revision:number;state_hash:string;state_json:string;approval_id:string|null;standing_id:string|null;standing_revision:number|null;approved_by:string;approved_owner_version:number;status:string;amount_cents:number;created_at:number}
export const grantPolicy=(g:Pick<Grant,'id'|'revision'|'owner_version'>):AppliedPolicy=>({grant:{id:g.id,revision:g.revision,ownerVersion:g.owner_version}})
export function grantFence(env:Bindings,g:Grant){
 return env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_grants g JOIN oa_operators o ON o.id=g.created_by
 WHERE g.id=? AND g.revision=? AND g.revoked_at IS NULL AND g.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=g.owner_version AND g.owner_version=?`).bind(g.id,g.revision,Date.now(),g.owner_version)
}
export async function grantById(db:D1Database,grantId:string){const grant=await db.prepare('SELECT id,name,definition,revision,created_by,owner_version,expires_at,revoked_at,reserved_cents,created_at FROM hnd_grants WHERE id=?').bind(grantId).first<Grant>();if(!grant)throw new Fault('grant_not_found',404);return grant}
async function selectedRecords(db:D1Database,records:string[],kind?:string){
 for(const recordId of records){
  const result=await db.prepare(kind?'SELECT kind FROM hnd_records WHERE id=?':'SELECT id FROM hnd_cases WHERE id=?').bind(recordId).first<{kind?:string}>()
  if(!result || kind && result.kind!==kind)throw new Fault('invalid_selected_record')
 }
}
export async function issue(env:Bindings,actor:Session,value:ObjectValue){
 keys(value,['name','definition','expiresAt','confirm'])
 if(value.confirm!=='approve scoped credential')throw new Fault('explicit_grant_consent_required')
 const d=definition(object(value.definition)),expiresAt=expires(value.expiresAt),grantId=id()
 await selectedRecords(env.DB,d.records);await selectedRecords(env.DB,d.numbers,'number');await selectedRecords(env.DB,d.recipients,'person')
 const random=crypto.getRandomValues(new Uint8Array(32)),token=btoa(String.fromCharCode(...random)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')
 const tokenHash=await digest(token),name=text(value.name,'name',80),now=Date.now()
 await commit(env,actor,'grant.create',grantId,'completed',[
  env.DB.prepare('INSERT INTO hnd_grants VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(grantId,name,tokenHash,JSON.stringify(d),1,actor.operator.id,actor.operator.version,expiresAt,null,0,now),
  env.DB.prepare('INSERT INTO hnd_authority_history VALUES (?,?,?,?,?,?)').bind(id(),grantId,1,JSON.stringify(d),actor.operator.id,now),
 ],true,grantPolicy({id:grantId,revision:1,owner_version:actor.operator.version}))
 return {grant:await grantById(env.DB,grantId),token}
}
export async function revokeGrant(env:Bindings,actor:Session,grantId:string){
 const grant=await grantById(env.DB,grantId)
 await commit(env,actor,'grant.revoke',grantId,'completed',[
  env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_grants WHERE id=? AND revision=?').bind(grant.id,grant.revision),
  env.DB.prepare('UPDATE hnd_grants SET revoked_at=COALESCE(revoked_at,?),revision=revision+1,reserved_cents=0 WHERE id=? AND revoked_at IS NULL').bind(Date.now(),grantId),
  env.DB.prepare("UPDATE hnd_jobs SET status='cancelled' WHERE grant_id=? AND status='held_adapter_unqualified'").bind(grantId),
 ],true,grantPolicy({...grant,revision:grant.revision+(grant.revoked_at?0:1)}))
 return {revoked:true}
}
export async function checkState(env:Bindings,grant:Grant,s:State){
 const d=JSON.parse(grant.definition) as Definition
 if(!d.tools.includes(s.operation)||!d.scopes.includes(s.operation==='comment.draft'?'draft':['case.read','recording.read'].includes(s.operation)?'read':'send'))throw new Fault('tool_out_of_scope',403)
 if(!d.records.includes(s.caseId))throw new Fault('record_out_of_scope',403)
 if(s.numberId&&!d.numbers.includes(s.numberId))throw new Fault('number_out_of_scope',403)
 if(s.recipients.some(r=>!d.recipients.includes(r)))throw new Fault('recipient_out_of_scope',403)
 if(s.amountCents>d.budgetCents || s.policyRevision!==d.policyRevision)throw new Fault('policy_or_budget_out_of_scope',403)
 if(['call.paid','message.send','campaign.launch','number.port','number.release'].includes(s.operation)&&!s.numberId)throw new Fault('number_required')
 if(['call.paid','message.send','campaign.launch'].includes(s.operation)&&!s.recipients.length)throw new Fault('recipient_required')
 if(s.operation==='flow.publish'&&!s.flowRevision)throw new Fault('flow_revision_required')
 if((await getCase(env.DB,s.caseId)).current.version!==s.caseVersion)throw new Fault('reviewed_case_changed',409)
 return d
}
export async function approve(env:Bindings,actor:Session,value:ObjectValue){
 keys(value,['grantId','state','expiresAt','confirm'])
 if(value.confirm!=='approve exact reviewed state')throw new Fault('explicit_human_approval_required')
 const grant=await grantById(env.DB,text(value.grantId,'grantId')),s=state(value.state),expiry=expires(value.expiresAt)
 if(grant.revoked_at||grant.expires_at<=Date.now())throw new Fault('grant_inactive',409)
 // Attestation-bearing operations remain human-only even with a paid-work grant.
 if(s.operation==='number.port')throw new Fault('human_attestation_door_unavailable',409)
 await checkState(env,grant,s)
 const approvalId=id(),stateHash=await digest(s),now=Date.now()
 await commit(env,actor,'approval.create',approvalId,'completed',[
  grantFence(env,grant),
  env.DB.prepare('INSERT INTO hnd_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(approvalId,grant.id,grant.revision,stateHash,JSON.stringify(s),actor.operator.id,actor.operator.version,Math.min(expiry,grant.expires_at),null,null,now),
 ],true,{...grantPolicy(grant),approval:{id:approvalId,revision:1,ownerVersion:actor.operator.version}})
 return {id:approvalId,state:s,stateHash,approvedBy:actor.operator.id,expiresAt:Math.min(expiry,grant.expires_at)}
}
export async function writeStanding(env:Bindings,actor:Session,value:ObjectValue,policyId?:string){
 keys(value,['grantId','bounds','expiresAt','confirm','revision'])
 if(value.confirm!=='approve standing call bounds')throw new Fault('explicit_standing_approval_required')
 const grant=await grantById(env.DB,text(value.grantId,'grantId')),b=bounds(value.bounds),expiry=Math.min(expires(value.expiresAt),grant.expires_at),now=Date.now(),target=policyId??id()
 const d=JSON.parse(grant.definition) as Definition
 if(grant.revoked_at||expiry<=now||!d.tools.includes('call.paid')||!d.scopes.includes('send')||!d.numbers.includes(b.numberId)||b.recipients.some(r=>!d.recipients.includes(r))||b.maxCents>d.budgetCents||b.policyRevision!==d.policyRevision)throw new Fault('standing_bounds_out_of_scope',403)
 let revision=1
 const statements:D1PreparedStatement[]=[grantFence(env,grant)]
 if(policyId){
  const current=await env.DB.prepare('SELECT * FROM hnd_standing WHERE id=? AND grant_id=?').bind(policyId,grant.id).first<Standing>()
  if(!current||current.revoked_at||current.revision!==integer(value.revision,'revision',1))throw new Fault('standing_revision_conflict',409)
  revision=current.revision+1
  statements.push(env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_standing WHERE id=? AND revision=? AND revoked_at IS NULL').bind(policyId,current.revision))
  statements.push(env.DB.prepare('UPDATE hnd_standing SET revision=?,bounds=?,approved_by=?,owner_version=?,expires_at=? WHERE id=?').bind(revision,JSON.stringify(b),actor.operator.id,actor.operator.version,expiry,policyId))
 }else statements.push(env.DB.prepare('INSERT INTO hnd_standing VALUES (?,?,?,?,?,?,?,?,?)').bind(target,grant.id,revision,JSON.stringify(b),actor.operator.id,actor.operator.version,expiry,null,now))
 statements.push(env.DB.prepare('INSERT INTO hnd_authority_history VALUES (?,?,?,?,?,?)').bind(id(),target,revision,JSON.stringify(b),actor.operator.id,now))
 await commit(env,actor,'policy.create',target,'completed',statements,true,{...grantPolicy(grant),standing:{id:target,revision,ownerVersion:actor.operator.version}})
 return {id:target,revision,bounds:b,approvedBy:actor.operator.id}
}
export const policyMatches=(b:Bounds,s:State)=>s.operation==='call.paid'&&s.numberId===b.numberId&&s.recipients.length>0&&s.recipients.length<=b.maxListSize&&s.recipients.every(r=>b.recipients.includes(r))&&s.amountCents<=b.maxCents&&s.flowRevision===b.flowRevision&&s.policyRevision===b.policyRevision
