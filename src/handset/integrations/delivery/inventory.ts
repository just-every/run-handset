import type { Bindings } from '../../../auth.server'
import { currentPolicy } from '../../receptionist/store'
import { receivingConnection, type Connector } from './connection'

interface Totals { kind: string; state: string; count: number; last_attempt_at: number; oldest_unresolved_at: number | null }
interface Attempt { kind: string; state: string; reason: string; updated_at: number }
interface Check { connector: Connector; mapping_version: number; checked_at: number; connection_key: string | null; state: string; delivery_state: string; step_id: string | null; delivery_started_at: number | null; first_delivery_at: number | null }
/** Local scope and observed delivery facts. Configuration never certifies remote OAuth or health. */
export async function connectorInventory(env: Bindings, steps: Attempt[], observedAt: number) {
 const [policy, totals, checks] = await Promise.all([
  currentPolicy(env.DB),
  env.DB.prepare(`SELECT kind,state,count(*) AS count,MAX(updated_at) AS last_attempt_at,
   MIN(CASE WHEN state IN ('sent','uncertain','held') THEN updated_at END) AS oldest_unresolved_at
   FROM hnd_rx_steps GROUP BY kind,state`).all<Totals>(),
  env.DB.prepare(`SELECT c.*, (SELECT MAX(checked_at) FROM hnd_delivery_checks success WHERE success.connector=c.connector
   AND success.target=c.target AND success.mapping_version=c.mapping_version AND success.connection_key IS c.connection_key AND success.state='available') AS last_success_at,
   (SELECT MIN(checked_at) FROM hnd_delivery_checks receipt WHERE receipt.connector=c.connector AND receipt.target=c.target
    AND receipt.mapping_version=c.mapping_version AND receipt.connection_key=c.connection_key AND receipt.step_id=c.step_id AND receipt.delivery_state='confirmed') AS first_delivery_at
   FROM hnd_delivery_checks c WHERE NOT EXISTS(SELECT 1 FROM hnd_delivery_checks newer WHERE newer.connector=c.connector AND newer.target=c.target AND newer.sequence>c.sequence)
   ORDER BY c.sequence DESC LIMIT 300`).all<Check>(),
 ])
 const definitions = [
  { id: 'dial', kinds: ['availability','booking'], configured: !!(env.HANDSET_DIAL_ORIGIN && env.HANDSET_DIAL_TOKEN),
   records: policy?.policy.services.map(s => ({ serviceId: s.id, eventTypeId: s.eventTypeId, bookingPage: s.bookingPage })) ?? [],
   fields: ['service to event type and booking page','call to booking answers','caller name and email','start time and timezone'] },
  { id: 'stripe', kinds: ['deposit','refund'], configured: !!env.HANDSET_STRIPE_KEY,
   records: policy ? [{ maxDepositCents: policy.policy.maxDepositCents, maxRefundCents: policy.policy.maxRefundCents, exceptionOwnerId: policy.policy.exceptionOwnerId }] : [],
   fields: ['outcome to payment metadata','exact approved amount and currency','saved payment method reference','refund to original payment'] },
  { id: 'orbit', kinds: ['crm'], configured: !!(env.HANDSET_ORBIT_ORIGIN && env.HANDSET_ORBIT_TOKEN),
   records: policy?.policy.orbitTarget ? [{ target: policy.policy.orbitTarget }] : [],
   fields: ['case and call to selected handoff','stable operation key','approved summary and receiving revision'] },
  { id: 'helpdesk', kinds: ['support'], configured: !!(env.HANDSET_HELPDESK_ORIGIN && env.HANDSET_HELPDESK_TOKEN),
   records: policy?.policy.supportConversations ?? [],
   fields: ['case to existing conversation','stable local message identity','approved summary and receiving revision'] },
 ]
 return Promise.all(definitions.map(async d => {
  const connection = await receivingConnection(env, d.id as Connector)
  const inspections = checks.results.filter(c => c.connector === d.id).map(c => {
   const { connection_key, ...observation } = c
   const stale = c.mapping_version !== policy?.version || connection_key === null || connection_key !== connection.key
   return { ...observation, stale, ageMs: Math.max(0, observedAt - c.checked_at),
    delivery: { state: c.delivery_state, stepId: c.step_id, startedAt: c.delivery_started_at,
     confirmedAt: c.delivery_state === 'confirmed' ? c.first_delivery_at : null,
     lagMs: c.delivery_state === 'confirmed' && c.first_delivery_at !== null && c.delivery_started_at !== null ? Math.max(0, c.first_delivery_at - c.delivery_started_at) : null,
     pendingAgeMs: c.delivery_state === 'pending' && c.delivery_started_at !== null ? Math.max(0, observedAt - c.delivery_started_at) : null } }
  })
  const current = inspections.filter(c => !c.stale), delivered = current.filter(c => c.state === 'available' && c.delivery.state === 'confirmed')
  const latestDelivery = delivered.sort((a,b) => b.delivery.confirmedAt! - a.delivery.confirmedAt!)[0]
  const rows = totals.results.filter(r => d.kinds.includes(r.kind)), latest = steps.find(s => d.kinds.includes(s.kind))
  const count = (states: string[]) => rows.filter(r => states.includes(r.state)).reduce((n, r) => n + r.count, 0)
  const lastSuccess = rows.filter(r => r.state === 'confirmed').map(r => r.last_attempt_at)
  const unresolved = rows.flatMap(r => r.oldest_unresolved_at === null ? [] : [r.oldest_unresolved_at])
  return { id: d.id, configuration: d.configured ? 'configured' : 'unconfigured', mappingVersion: policy?.version ?? null,
   mappedRecords: d.records, mappedFields: d.fields, remoteAuthorization: 'Read scope only when explicitly inspected; write authority is separate', remoteLagMs: latestDelivery?.delivery.lagMs ?? null,
   lagBasis: 'Initial local effect claim to first exact readback at the current receiver; observed upper bound, not remote processing time',
   currentDelivery: latestDelivery?.delivery ?? null, inspections,
   lastSuccessfulAt: lastSuccess.length ? Math.max(...lastSuccess) : null,
   lastCurrentDeliveryAt: latestDelivery?.delivery.confirmedAt ?? null,
   lastAttempt: latest ? { state: latest.state, reason: latest.reason, observedAt: latest.updated_at } : null,
   attempts: { confirmed: count(['confirmed']), rejected: count(['rejected']), held: count(['held']), uncertain: count(['sent','uncertain']) },
   oldestUnresolvedAgeMs: unresolved.length ? Math.max(0, observedAt - Math.min(...unresolved)) : null,
  }
 }))
}
