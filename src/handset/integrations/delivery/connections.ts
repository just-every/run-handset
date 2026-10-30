import type { Bindings } from '../../../auth.server'
import { activeSourceById } from '../../providers/sources'
import { currentPolicy } from '../../receptionist/store'

/** Configuration and observed receipts, never a claim of remote health or consent. */
export async function connections(env:Bindings,at:number) {
 const [policy,steps,sources]=await Promise.all([
  currentPolicy(env.DB),
  env.DB.prepare(`SELECT kind,count(*) AS attempts,
   max(CASE WHEN state='confirmed' THEN updated_at END) AS last_confirmed_at,
   min(CASE WHEN state IN ('sent','uncertain','held') THEN created_at END) AS unresolved_since,
   sum(CASE WHEN state IN ('sent','uncertain','held') THEN 1 ELSE 0 END) AS unresolved,
   sum(CASE WHEN state='rejected' THEN 1 ELSE 0 END) AS refused
   FROM hnd_rx_steps GROUP BY kind`).all<{kind:string;attempts:number;last_confirmed_at:number|null;unresolved_since:number|null;unresolved:number;refused:number}>(),
  env.DB.prepare(`SELECT s.id,s.account_id,s.number_id,s.revision,s.revoked_at,
   max(r.received_at) AS last_receipt_at,max(r.occurred_at) AS last_source_at,
   max(r.received_at-r.occurred_at) AS largest_observed_lag_ms,
   (SELECT count(*) FROM hnd_source_pending p WHERE p.source_id=s.id) AS pending_parents
   FROM hnd_sources s LEFT JOIN hnd_source_receipts r ON r.source_id=s.id
   GROUP BY s.id ORDER BY s.created_at DESC,s.id LIMIT 100`).all<{id:string;account_id:string;number_id:string;revision:number;revoked_at:number|null;last_receipt_at:number|null;last_source_at:number|null;largest_observed_lag_ms:number|null;pending_parents:number}>(),
 ])
 const authority=policy?await env.DB.prepare("SELECT id FROM oa_operators WHERE id=? AND version=? AND status='active' AND role='owner'").bind(policy.row.owner_id,policy.row.owner_version).first():null
 const definitions=[
  {id:'dial',configured:Boolean(env.HANDSET_DIAL_ORIGIN&&env.HANDSET_DIAL_TOKEN),kinds:['availability','booking'],scope:'Selected service availability and one booking per exact approved request',fields:['service','start time','caller name and address','call and case correlation'],mappings:policy?.policy.services.map(s=>({serviceId:s.id,eventTypeId:s.eventTypeId,bookingPage:s.bookingPage}))??[]},
  {id:'stripe',configured:Boolean(env.HANDSET_STRIPE_KEY),kinds:['deposit','refund'],scope:'Exact caller-authorized saved-method deposit and separately approved refund',fields:['amount','currency','saved payment reference','outcome correlation'],mappings:policy?[{maxDepositCents:policy.policy.maxDepositCents,maxRefundCents:policy.policy.maxRefundCents}]:[]},
  {id:'orbit',configured:Boolean(env.HANDSET_ORBIT_ORIGIN&&env.HANDSET_ORBIT_TOKEN),kinds:['crm'],scope:'Selected delegated opportunity handoff',fields:['target','operation key','reviewed handoff summary'],mappings:policy?.policy.orbitTarget?[{target:policy.policy.orbitTarget}]:[]},
  {id:'helpdesk',configured:Boolean(env.HANDSET_HELPDESK_ORIGIN&&env.HANDSET_HELPDESK_TOKEN),kinds:['support'],scope:'Selected existing conversation note; no ticket-create authority',fields:['conversation','local key','reviewed note'],mappings:policy?.policy.supportConversations??[]},
 ]
 const receivers=await Promise.all(definitions.map(async d=>{
  const rows=steps.results.filter(row=>d.kinds.includes(row.kind))
  const last=await env.DB.prepare('SELECT id,kind,state,reason,updated_at FROM hnd_rx_steps WHERE kind IN (SELECT value FROM json_each(?)) ORDER BY updated_at DESC,id DESC LIMIT 1').bind(JSON.stringify(d.kinds)).first()
  const successes=rows.flatMap(r=>r.last_confirmed_at===null?[]:[r.last_confirmed_at]),unresolved=rows.flatMap(r=>r.unresolved_since===null?[]:[r.unresolved_since])
  return {...d,policyVersion:policy?.version??null,authority:!policy?'unconfigured':authority?'current':'suspended',
   remoteAuthorization:last?.reason??'not observed; credentials checked at the receiver',lastAttempt:last,
   lastConfirmedAt:successes.length?Math.max(...successes):null,
   unresolved:rows.reduce((n,r)=>n+r.unresolved,0),refused:rows.reduce((n,r)=>n+r.refused,0),
   unresolvedAgeMs:unresolved.length?Math.max(0,at-Math.min(...unresolved)):null,
   repair:'/api/handset/application/receptionist/outcomes/{id}/reconcile',
  }
 }))
 const sourceRows=await Promise.all(sources.results.map(async source=>({...source,
  authority:source.revoked_at!==null?'revoked':await activeSourceById(env,source.id)?'current':'suspended',
  receiptAgeMs:source.last_receipt_at===null?null:Math.max(0,at-source.last_receipt_at),
  scope:'Signed metadata for the exact account and native number; outbound effects require separate approval',
  fields:['provider event and object identities','source time','receipt time','canonical case and record'],
  repair:'/api/handset/sources',
 })))
 return {receivers,sources:sourceRows,lagMeaning:'Receipt age and unresolved work age are local observations, not remote service health or an inbox receipt'}
}

/** Bounded repair projections deliberately omit content, credentials and recipients. */
export async function supportingConnections(env:Bindings,at:number) {
 const [knowledge,exports,care,notices,processing]=await Promise.all([
  env.DB.prepare(`SELECT s.id,s.provider,s.external_id,s.revision,s.source_revision,s.state,s.refreshed_at,s.expires_at,
   CASE WHEN s.state IN ('revoked','erased') THEN s.state
   WHEN s.expires_at<=? OR NOT EXISTS(SELECT 1 FROM oa_operators o WHERE o.id=s.owner_id AND o.version=s.owner_version AND o.status='active' AND o.role='owner') THEN 'unavailable' ELSE s.state END AS authority
   FROM hnd_knowledge_sources s ORDER BY s.refreshed_at DESC,s.id LIMIT 100`).bind(at).all(),
  env.DB.prepare(`SELECT c.id,c.provider,json_extract(c.destination,'$.folder') AS folder,c.retention_days,
   CASE WHEN c.revoked_at IS NOT NULL THEN 'revoked' WHEN EXISTS(SELECT 1 FROM oa_operators o WHERE o.id=c.owner_id AND o.version=c.owner_version AND o.status='active' AND o.role='owner') THEN 'current' ELSE 'suspended' END AS authority,
   (SELECT max(a.occurred_at) FROM hnd_audit a JOIN hnd_export_jobs j ON j.id=a.subject WHERE j.connector_id=c.id AND a.action='exports.transfer' AND a.outcome='completed') AS last_transfer_at
   FROM hnd_export_connectors c ORDER BY c.created_at DESC,c.id LIMIT 100`).all(),
  env.DB.prepare(`SELECT t.id,t.permission_id,c.source_id,t.state,t.provider_sid,t.reason,t.created_at,t.accepted_at,t.delivered_at,t.submitted_at,t.readback_at,t.provider_state FROM hnd_care_texts t JOIN hnd_text_permissions p ON p.id=t.permission_id JOIN hnd_consent_calls c ON c.id=p.call_id ORDER BY t.created_at DESC,t.id LIMIT 200`).all(),
  env.DB.prepare(`SELECT id,'report' AS kind,state,due_at,report_id AS correlation FROM hnd_metric_schedules
   UNION ALL SELECT id,'export' AS kind,state,due_at,NULL AS correlation FROM hnd_export_schedules
   ORDER BY due_at DESC,id LIMIT 200`).all(),
  env.DB.prepare(`SELECT r.id,r.consent_id,c.source_id,c.source_revision,c.purpose,r.state,r.created_at,c.state AS consent_state FROM hnd_knowledge_runs r JOIN hnd_knowledge_consents c ON c.id=r.consent_id ORDER BY r.created_at DESC,r.id LIMIT 200`).all(),
 ])
 const archiveJobs=(await env.DB.prepare(`SELECT id,connector_id,state,error,created_at,manifest_hash,
  (SELECT count(*) FROM hnd_export_files f WHERE f.job_id=j.id AND f.state IN ('verified','client_verified')) AS confirmed_files,
  (SELECT count(*) FROM hnd_export_files f WHERE f.job_id=j.id AND f.state IN ('pending','ready')) AS pending_files
  FROM hnd_export_jobs j ORDER BY created_at DESC,id LIMIT 200`).all()).results
 return {
  knowledge:knowledge.results.map(s=>({...s,receiptAgeMs:Math.max(0,at-Number(s.refreshed_at)),scope:'Exact source text for consented owner retrieval; credentials supplied per request',fields:['source identity','source revision','citation','bounded text'],repair:'/api/handset/knowledge/'+s.id+'/refresh'})),
  exports:exports.results.map(c=>({...c,scope:'Reviewed encrypted archive to the selected folder; credentials supplied per transfer',fields:['encrypted audio','encrypted transcript','encrypted manifest'],repair:'/api/handset/exports'})),
  archiveJobs,careTexts:care.results,notices:notices.results,processing:processing.results,
  limits:{knowledge:100,exports:100,archiveJobs:200,careTexts:200,notices:200,processing:200},
  noticeBoundary:'Provider acceptance is not inbox receipt. Started notices are never automatically resent.',
 }
}
