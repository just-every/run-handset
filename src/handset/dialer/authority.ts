import { Fault, id, integer, keys, owner, text, type ObjectValue } from '../core'
import { expiry, listOf } from './model'
import { guard, sql, write, type Context } from './storage'

export async function scopeApprover(ctx:Context,v:ObjectValue){
 owner(ctx.actor!);keys(v,['operatorId','sourceIds','queueIds','budgetCents','standing','reviewAt','revision','confirm'])
 if(v.confirm!=='grant exact campaign approval scope')throw new Fault('explicit_approval_scope_required',403)
 const operatorId=text(v.operatorId,'operatorId'),sources=listOf(v.sourceIds,'sourceIds'),queues=listOf(v.queueIds,'queueIds'),budget=integer(v.budgetCents,'budgetCents',1,1000000),standing=integer(v.standing,'standing',0,1),reviewAt=expiry(v.reviewAt,90*86400000)
 const old=await sql(ctx,'SELECT revision FROM hnd_dialer_approver_scopes WHERE operator_id=?',operatorId).first<{revision:number}>()
 if(old&&integer(v.revision,'revision',1)!==old.revision)throw new Fault('approval_scope_revision_conflict',409)
 await write(ctx,'installation',[guard(ctx,"SELECT count(*) FROM oa_operators WHERE id=? AND status='active'",operatorId),...sources.map(s=>guard(ctx,'SELECT count(*) FROM hnd_sources WHERE id=? AND revoked_at IS NULL',s)),...queues.map(q=>guard(ctx,'SELECT count(*) FROM hnd_queues WHERE id=?',q)),...(old?[guard(ctx,'SELECT count(*) FROM hnd_dialer_approver_scopes WHERE operator_id=? AND revision=?',operatorId,old.revision)]:[guard(ctx,'SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_dialer_approver_scopes WHERE operator_id=?) THEN 0 ELSE 1 END',operatorId)]),sql(ctx,'INSERT INTO hnd_dialer_approver_scopes VALUES (?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(operator_id) DO UPDATE SET source_ids=excluded.source_ids,queue_ids=excluded.queue_ids,budget_cents=excluded.budget_cents,standing=excluded.standing,review_at=excluded.review_at,revision=excluded.revision,approved_by=excluded.approved_by,owner_version=excluded.owner_version,revoked_at=NULL',operatorId,JSON.stringify(sources),JSON.stringify(queues),budget,standing,reviewAt,(old?.revision??0)+1,ctx.actor!.operator.id,ctx.actor!.operator.version)])
 return {operatorId,revision:(old?.revision??0)+1}
}
/** Exact source, queue and budget authority, checked again at every launch.
 * Scope rows are granted by a current owner, with explicit manager policy power. */
export function approvalFence(ctx:Context,operatorId:string,version:number,sourceId:string,queueId:string,budget:number,standing=false){
 return guard(ctx,`SELECT count(*) FROM oa_operators o WHERE o.id=? AND o.version=? AND o.status='active' AND
 (o.role='owner' OR EXISTS(SELECT 1 FROM hnd_dialer_approver_scopes a JOIN oa_operators issuer ON issuer.id=a.approved_by WHERE a.operator_id=o.id AND a.revoked_at IS NULL AND a.review_at>? AND a.budget_cents>=? AND (?=0 OR a.standing=1) AND EXISTS(SELECT 1 FROM json_each(a.source_ids) WHERE value=?) AND EXISTS(SELECT 1 FROM json_each(a.queue_ids) WHERE value=?) AND issuer.role='owner' AND issuer.status='active' AND issuer.version=a.owner_version))`,operatorId,version,Date.now(),budget,standing?1:0,sourceId,queueId)
}
export async function mayApprove(ctx:Context,operatorId:string,version:number,sourceId:string,queueId:string,budget:number,standing=false){
 // Reuse the same predicate for the user-facing refusal and atomic fence.
 const fence=approvalFence(ctx,operatorId,version,sourceId,queueId,budget,standing)
 // D1 statements cannot expose bindings: read the corresponding authority explicitly.
 const operator=await sql(ctx,"SELECT role FROM oa_operators WHERE id=? AND version=? AND status='active'",operatorId,version).first<{role:string}>()
 if(!operator)throw new Fault('approval_scope_required',403)
 if(operator.role!=='owner'){
  const scope=await sql(ctx,`SELECT a.* FROM hnd_dialer_approver_scopes a JOIN oa_operators issuer ON issuer.id=a.approved_by WHERE a.operator_id=? AND a.revoked_at IS NULL AND a.review_at>? AND issuer.role='owner' AND issuer.status='active' AND issuer.version=a.owner_version`,operatorId,Date.now()).first<{source_ids:string;queue_ids:string;budget_cents:number;standing:number}>()
  if(!scope||!JSON.parse(scope.source_ids).includes(sourceId)||!JSON.parse(scope.queue_ids).includes(queueId)||scope.budget_cents<budget||standing&&!scope.standing)throw new Fault('approval_scope_required',403)
 }
 return fence
}
