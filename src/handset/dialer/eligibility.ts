import { mayApprove } from './authority'
import { registryChecks, stateChecks } from './compliance'
import { Fault } from '../core'
import { source, sourceGuard } from './configuration'
import { currentOwner, evidence, guard, ownerGuard, qualification, sql, type Context } from './storage'
import type { List, ListDefinition, Mode, QualificationDefinition, Recipient, RecipientCheck, RecipientDefinition } from './model'
export async function listEligibility(ctx:Context,l:List,mode:Mode){
 const now=Date.now(),d=JSON.parse(l.definition) as ListDefinition,q=await qualification(ctx,l.qualification_id),policy=JSON.parse(q.definition) as QualificationDefinition
 if(l.revoked_at||l.expires_at<=now)throw new Fault('list_approval_revoked',409)
 if(q.revoked_at||q.expires_at<=now||!await currentOwner(ctx,q.approved_by,q.owner_version))throw new Fault('qualification_not_current',409)
 if(!d.modes.includes(mode)||!policy.modes.includes(mode))throw new Fault('mode_ineligible',409)
 const s=await source(ctx,l.source_id)
 if(q.source_id!==s.id||JSON.parse(s.data).e164!==d.from)throw new Fault('source_scope_changed',409)
 const fences=[await mayApprove(ctx,l.approved_by,l.owner_version,l.source_id,l.queue_id,d.budgetCents,Boolean(l.policy_id)),sourceGuard(ctx,s),ownerGuard(ctx,q.approved_by,q.owner_version),guard(ctx,'SELECT count(*) FROM hnd_dialer_lists WHERE id=? AND revoked_at IS NULL AND expires_at>?',l.id,now),guard(ctx,'SELECT count(*) FROM hnd_dialer_qualifications WHERE id=? AND revoked_at IS NULL AND expires_at>?',q.id,now)]
 for(const record of [policy.legalEvidenceId,policy.providerEvidenceId,policy.trafficEvidenceId])fences.push(await evidence(ctx,record))
 if(l.policy_id){
  const p=await sql(ctx,'SELECT approved_by,owner_version FROM hnd_dialer_policies WHERE id=? AND revision=? AND revoked_at IS NULL AND expires_at>?',l.policy_id,l.policy_revision,now).first<{approved_by:string;owner_version:number}>()
  if(!p)throw new Fault('standing_policy_revoked',409)
  fences.push(await mayApprove(ctx,p.approved_by,p.owner_version,l.source_id,l.queue_id,d.budgetCents,true),guard(ctx,'SELECT count(*) FROM hnd_dialer_policies WHERE id=? AND revision=? AND revoked_at IS NULL AND expires_at>?',l.policy_id,l.policy_revision,now))
 }
 return {definition:d,qualification:q,policy,source:s,fences}
}
export async function recipientEligibility(ctx:Context,l:List,r:Recipient,mode:Mode,policy:QualificationDefinition,excludeAttemptId=''){
 const now=Date.now(),d=JSON.parse(r.definition) as RecipientDefinition
 if(!policy.jurisdictions.includes(d.jurisdiction))throw new Fault('jurisdiction_ineligible',409)
 const consent=await sql(ctx,"SELECT data FROM hnd_records WHERE id=? AND kind='consent' AND case_id=? AND parent_id=? AND NOT EXISTS(SELECT 1 FROM hnd_records newer WHERE newer.supersedes_id=hnd_records.id)",d.consentId,r.case_id,r.person_id).first<{data:string}>()
 if(!consent||JSON.parse(consent.data).purpose!==l.purpose||['declined','held','unknown','uncertain'].includes(JSON.parse(consent.data).state))throw new Fault('consent_unknown_or_revoked',409)
 const check=await sql(ctx,'SELECT * FROM hnd_dialer_checks WHERE list_id=? AND ordinal=? ORDER BY rowid DESC LIMIT 1',l.id,r.ordinal).first<{id:string;definition:string;checked_by:string;owner_version:number;checked_at:number;expires_at:number}>()
 if(!check||check.expires_at<=now||check.checked_at>now||!await currentOwner(ctx,check.checked_by,check.owner_version))throw new Fault('current_recipient_verification_required',409)
 const verified=JSON.parse(check.definition) as RecipientCheck
 if(verified.purpose!==l.purpose||!verified.methods.includes(mode))throw new Fault('consent_mode_or_purpose_ineligible',409)
 for(const scope of ['company','national','state','campaign'] as const)if(verified[scope]!=='clear')throw new Fault(scope+'_dnc_'+verified[scope],409)
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:d.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)),minute=Number(parts.find(p=>p.type==='hour')?.value)*60+Number(parts.find(p=>p.type==='minute')?.value)
 if(!Number.isFinite(minute)||minute<d.startMinute||minute>=d.endMinute)throw new Fault('recipient_quiet_hours',409)
 const s=await source(ctx,l.source_id),compliance=[...await registryChecks(ctx,s.number_id,r.recipient,d),...await stateChecks(ctx,r.recipient,d,mode,true,excludeAttemptId)],stop=await sql(ctx,"SELECT reason FROM hnd_protection_stops WHERE (number_id=? OR reason='dnc') AND recipient=? AND channel IN ('voice','all') LIMIT 1",s.number_id,r.recipient).first<{reason:string}>()
 if(stop)throw new Fault(stop.reason,409)
 const contained=await sql(ctx,"SELECT id FROM hnd_protection_alerts WHERE number_id=? AND device_id=? AND channel='voice' AND released_at IS NULL",s.number_id,l.id).first()
 if(contained)throw new Fault('device_contained',409)
 const person=await sql(ctx,"SELECT id FROM hnd_records WHERE id=? AND kind='person' AND case_id=? AND NOT EXISTS(SELECT 1 FROM hnd_records newer WHERE newer.supersedes_id=hnd_records.id)",r.person_id,r.case_id).first()
 if(!person)throw new Fault('recipient_person_changed',409)
 const owner=JSON.parse(l.definition).repId
 if(l.policy_id&&!await sql(ctx,'SELECT id FROM hnd_cases WHERE id=? AND owner_id=?',r.case_id,owner).first())throw new Fault('outside_crm_owner',409)
 return [...compliance,await evidence(ctx,d.consentId),await evidence(ctx,verified.consentEvidenceId),ownerGuard(ctx,check.checked_by,check.owner_version),guard(ctx,'SELECT count(*) FROM hnd_dialer_checks WHERE id=? AND expires_at>? AND rowid=(SELECT max(rowid) FROM hnd_dialer_checks WHERE list_id=? AND ordinal=?)',check.id,now,l.id,r.ordinal),guard(ctx,"SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_protection_stops WHERE (number_id=? OR reason='dnc') AND recipient=? AND channel IN ('voice','all')) THEN 0 ELSE 1 END",s.number_id,r.recipient),guard(ctx,"SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_protection_alerts WHERE number_id=? AND device_id=? AND channel='voice' AND released_at IS NULL) THEN 0 ELSE 1 END",s.number_id,l.id),...(l.policy_id?[guard(ctx,'SELECT count(*) FROM hnd_cases WHERE id=? AND owner_id=?',r.case_id,owner)]:[])]
}
