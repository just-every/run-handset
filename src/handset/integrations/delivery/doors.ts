import type { Bindings } from '../../../auth.server'
import type { Session } from '../../../modules/operator-auth/index.mjs'
import { Fault, json, owner } from '../../core'
import { activeSourceById } from '../../providers/sources'
import { connectorInventory } from './inventory'
/** Read-only native-owner repair inventory. Credentials and provider payloads are never returned. */
export async function deliveryDoor(request: Request, env: Bindings, actor: Session): Promise<Response | null> {
 if (new URL(request.url).pathname !== '/api/handset/delivery') return null
 owner(actor)
 if (request.method !== 'GET') throw new Fault('method_not_allowed', 405)
 const observedAt = Date.now()
 const [sources, steps, followups, rules, messages] = await Promise.all([
  env.DB.prepare(`SELECT s.id,s.account_id,s.number_id,s.revision,s.revoked_at,MAX(r.received_at) AS last_receipt_at,MAX(r.occurred_at) AS last_source_at,MAX(r.received_at-r.occurred_at) AS largest_observed_lag_ms,
  (SELECT received_at-occurred_at FROM hnd_source_receipts last WHERE last.source_id=s.id ORDER BY received_at DESC,event_id DESC LIMIT 1) AS last_event_lag_ms,
  (SELECT MIN(received_at) FROM hnd_source_pending p WHERE p.source_id=s.id) AS oldest_pending_at,
  (SELECT count(*) FROM hnd_source_pending p WHERE p.source_id=s.id) AS pending_parents
  FROM hnd_sources s LEFT JOIN hnd_source_receipts r ON r.source_id=s.id GROUP BY s.id ORDER BY s.created_at DESC,s.id LIMIT 100`).all<{id: string; revoked_at: number | null; oldest_pending_at: number | null}>(),
  env.DB.prepare(`SELECT s.id,s.outcome_id,s.kind,s.state,s.reason,s.external_id,s.attempts,s.created_at,s.updated_at,o.case_id FROM hnd_rx_steps s JOIN hnd_rx_outcomes o ON o.id=s.outcome_id ORDER BY s.updated_at DESC,s.id DESC LIMIT 200`).all<{id: string; outcome_id: string; kind: string; state: string; reason: string; external_id: string | null; created_at: number; updated_at: number}>(),
  env.DB.prepare('SELECT id,case_id,status,delivery,reason,next_due_at,updated_at FROM hnd_followups ORDER BY updated_at DESC LIMIT 200').all(),
  env.DB.prepare('SELECT id,rule_id,record_id,case_id,state,work_status,reason,next_due_at,updated_at FROM hnd_rule_runs ORDER BY updated_at DESC LIMIT 200').all(),
  env.DB.prepare(`SELECT j.id,j.thread_id,t.source_id,j.state,j.reason,j.provider_sid,j.provider_state,j.carrier_state,j.due_at,j.approved_at,j.created_at
   FROM hnd_message_jobs j JOIN hnd_message_threads t ON t.id=j.thread_id ORDER BY j.created_at DESC,j.id DESC LIMIT 200`).all(),
 ])
 const currentSources = await Promise.all(sources.results.map(async s => ({ ...s,
  status: s.revoked_at !== null ? 'revoked' : await activeSourceById(env, s.id) ? 'active' : 'suspended',
  oldestPendingAgeMs: s.oldest_pending_at === null ? null : Math.max(0, observedAt - s.oldest_pending_at),
 })))
 const connections = await connectorInventory(env, steps.results, observedAt)
 const repairSteps = steps.results.map(s => ({ ...s, repair: {
  path: `/api/handset/application/receptionist/outcomes/${s.outcome_id}/reconcile`, body: { step: s.kind },
  authority: 'Current exact-case application grant required; owner inventory grants no effect authority',
  mode: s.external_id || ['crm','support'].includes(s.kind) ? 'readback_first' : ['deposit','refund'].includes(s.kind) && observedAt - s.created_at >= 23 * 3600000 ? 'human_resolution_required' : 'same_key_within_receiver_contract',
 } }))
 return json({ observedAt, connections, scopes: {
  twilio: 'Signed metadata for explicitly selected numbers; no outbound authority',
  dial: 'Availability and booking; delegated booking qualification pending',
  stripe: 'Exact caller-authorized saved-method deposit and named-person refund',
  orbit: 'Selected delegated opportunity handoff and optional current handoff state',
  helpdesk: 'Selected existing conversation note; no ticket-create authority',
  rules: 'Owned internal work and explicitly published installation-owner notices; customer contact held',
  messages: 'Exact reviewed customer-care messages; current source, consent, recipient hours, custody and registration required',
 }, mappedFields: ['source event and call identity','case, outcome and step correlation','exact approved request','provider receipt','current completion separately from delivery'], sources: currentSources, steps: repairSteps,
 followups: followups.results, ruleRuns: rules.results, messageJobs: messages.results, limits: { sources: 100, steps: 200, followups: 200, ruleRuns: 200, messageJobs: 200 },
 repair: { startedEffect: 'Read back the existing idempotency key or obtain an explicit human resolution; never create a new key',
 followup: '/api/handset/followups/{id}/reconcile', outcome: '/api/handset/application/receptionist/outcomes/{id}/reconcile',
 mail: 'Provider acceptance is not inbox delivery. Uncertain owner notices are never automatically resent.' } })
}
