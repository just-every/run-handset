import type { Bindings } from '../../../auth.server'
import type { Session } from '../../../modules/operator-auth/index.mjs'
import { commit } from '../../audit/store'
import { connections, supportingConnections } from './connections'
import { Fault, json, owner } from '../../core'
/** Read-only native-owner repair inventory. Credentials and provider payloads are never returned. */
export async function deliveryDoor(request: Request, env: Bindings, actor: Session): Promise<Response | null> {
 if (new URL(request.url).pathname !== '/api/handset/delivery') return null
 owner(actor)
 if (request.method !== 'GET') throw new Fault('method_not_allowed', 405)
 const [connectionState, steps, followups, rules, messages, supporting] = await Promise.all([
  connections(env,Date.now()),
  env.DB.prepare(`SELECT s.id,s.outcome_id,s.kind,s.state,s.reason,s.external_id,s.destination_origin,s.attempts,s.updated_at,o.case_id FROM hnd_rx_steps s JOIN hnd_rx_outcomes o ON o.id=s.outcome_id ORDER BY s.updated_at DESC LIMIT 200`).all(),
  env.DB.prepare('SELECT id,case_id,status,delivery,reason,next_due_at,updated_at FROM hnd_followups ORDER BY updated_at DESC LIMIT 200').all(),
  env.DB.prepare('SELECT id,rule_id,record_id,case_id,state,work_status,reason,next_due_at,updated_at FROM hnd_rule_runs ORDER BY updated_at DESC LIMIT 200').all(),
  env.DB.prepare('SELECT j.id,j.thread_id,t.source_id,j.state,j.reason,j.provider_state,j.carrier_state,j.provider_sid,j.submitted_at,j.readback_at,j.revision FROM hnd_message_jobs j JOIN hnd_message_threads t ON t.id=j.thread_id ORDER BY j.created_at DESC,j.id LIMIT 200').all(),
  supportingConnections(env,Date.now()),
 ])
 await commit(env,actor,'delivery.request','installation','completed')
 return json({ supporting, observedAt: Date.now(), scopes: {
  twilio: 'Signed metadata for explicitly selected numbers; no outbound authority',
  dial: 'Availability and booking; delegated booking qualification pending',
  stripe: 'Exact caller-authorized saved-method deposit and named-person refund',
  orbit: 'Selected delegated opportunity handoff and optional current handoff state',
  helpdesk: 'Selected existing conversation note; no ticket-create authority',
  rules: 'Owned internal work and explicitly published installation-owner notices; customer contact held',
 }, mappedFields: ['source event and call identity','case, outcome and step correlation','exact approved request','provider receipt','current completion separately from delivery'], sources: connectionState.sources, connections: connectionState.receivers, lagMeaning: connectionState.lagMeaning, steps: steps.results,
 followups: followups.results, ruleRuns: rules.results, messages: messages.results, limits: { sources: 100, steps: 200, followups: 200, ruleRuns: 200, messages: 200 },
 repair: { message: '/api/handset/messages/jobs/{id}/reconcile', startedEffect: 'Read back the existing idempotency key or obtain an explicit human resolution; never create a new key',
 followup: '/api/handset/followups/{id}/reconcile', outcome: '/api/handset/application/receptionist/outcomes/{id}/reconcile',
 mail: 'Provider acceptance is not inbox delivery. Uncertain owner notices are never automatically resent.' } })
}
