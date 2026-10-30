import type { Bindings } from '../../../auth.server'
import { currentPolicy } from '../../receptionist/store'

interface Totals { kind: string; state: string; count: number; last_attempt_at: number; oldest_unresolved_at: number | null }
interface Attempt { kind: string; state: string; reason: string; updated_at: number }
/** Local scope and observed delivery facts. Configuration never certifies remote OAuth or health. */
export async function connectorInventory(env: Bindings, steps: Attempt[], observedAt: number) {
 const [policy, totals] = await Promise.all([
  currentPolicy(env.DB),
  env.DB.prepare(`SELECT kind,state,count(*) AS count,MAX(updated_at) AS last_attempt_at,
   MIN(CASE WHEN state IN ('sent','uncertain','held') THEN updated_at END) AS oldest_unresolved_at
   FROM hnd_rx_steps GROUP BY kind,state`).all<Totals>(),
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
 return definitions.map(d => {
  const rows = totals.results.filter(r => d.kinds.includes(r.kind)), latest = steps.find(s => d.kinds.includes(s.kind))
  const count = (states: string[]) => rows.filter(r => states.includes(r.state)).reduce((n, r) => n + r.count, 0)
  const lastSuccess = rows.filter(r => r.state === 'confirmed').map(r => r.last_attempt_at)
  const unresolved = rows.flatMap(r => r.oldest_unresolved_at === null ? [] : [r.oldest_unresolved_at])
  return { id: d.id, configuration: d.configured ? 'configured' : 'unconfigured', mappingVersion: policy?.version ?? null,
   mappedRecords: d.records, mappedFields: d.fields, remoteAuthorization: 'not_checked_by_inventory', remoteLagMs: null,
   lastSuccessfulAt: lastSuccess.length ? Math.max(...lastSuccess) : null,
   lastAttempt: latest ? { state: latest.state, reason: latest.reason, observedAt: latest.updated_at } : null,
   attempts: { confirmed: count(['confirmed']), rejected: count(['rejected']), held: count(['held']), uncertain: count(['sent','uncertain']) },
   oldestUnresolvedAgeMs: unresolved.length ? Math.max(0, observedAt - Math.min(...unresolved)) : null,
  }
 })
}
