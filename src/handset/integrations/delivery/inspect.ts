import type { Bindings } from '../../../auth.server'
import type { Session } from '../../../modules/operator-auth/index.mjs'
import { commit } from '../../audit/store'
import { choice, Fault, integer, keys, ownerFence, text, type ObjectValue } from '../../core'
import { bearer, origin, send, type Wire } from '../../receptionist/edge'
import { currentPolicy } from '../../receptionist/store'

const families = ['dial','stripe','orbit','helpdesk'] as const
interface Probe { target: string; path?: string; matches?: (body: Record<string, unknown>) => boolean }
interface Known { external_id: string; outcome_id: string; amount_cents: number; call_id: string; request: string }
const policyFence = (env: Bindings, version: number) => env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT CASE WHEN (SELECT max(version) FROM hnd_rx_policy)=? THEN 1 ELSE 0 END').bind(version)
/** Explicit owner inspection reads only native selected targets; it cannot settle or replay an effect. */
export async function inspectConnector(env: Bindings, actor: Session, value: ObjectValue) {
 keys(value, ['connector','mappingVersion','cursor','confirm'])
 if (value.confirm !== 'inspect current connector read scope') throw new Fault('explicit_connector_inspection_required', 403)
 const connector = choice(value.connector, families, 'connector'), current = await currentPolicy(env.DB)
 const version = integer(value.mappingVersion, 'mappingVersion', 1)
 if (!current || version !== current.version) throw new Fault('connector_mapping_changed', 409)
 const cursor = value.cursor === undefined ? '' : text(value.cursor, 'cursor', 300)
 const known = async (kind: string, service?: string) => env.DB.prepare(`SELECT s.external_id,s.outcome_id,s.amount_cents,s.request,o.call_id
  FROM hnd_rx_steps s JOIN hnd_rx_outcomes o ON o.id=s.outcome_id WHERE s.kind=? AND s.external_id IS NOT NULL
  AND o.policy_version=? AND (? IS NULL OR json_extract(s.request,'$.serviceId')=?) ORDER BY s.updated_at DESC,s.id DESC LIMIT 1`)
  .bind(kind, version, service ?? null, service ?? null).first<Known>()
 const probes: Probe[] = []
 if (connector === 'orbit' && current.policy.orbitTarget) probes.push({ target: current.policy.orbitTarget,
  path: '/api/delegation/v1/check?target=' + encodeURIComponent(current.policy.orbitTarget),
  matches: b => Number.isSafeInteger(b.revision) && Number.isSafeInteger(b.audienceRevision) })
 if (connector === 'helpdesk') for (const target of new Set(current.policy.supportConversations?.map(m => m.conversationId) ?? [])) probes.push({ target,
  path: '/api/v1/conversations/' + encodeURIComponent(target), matches: b => b.id === target && Number.isSafeInteger(b.revision) })
 if (connector === 'dial') for (const service of current.policy.services) {
  const record = await known('booking', service.id)
  probes.push({ target: service.id, ...(record ? { path: '/api/app/bookings/' + encodeURIComponent(record.external_id),
   matches: (b: Record<string, unknown>) => b.id === record.external_id && b.eventTypeId === service.eventTypeId && (b.answers as Record<string, unknown> | undefined)?.handsetCall === record.call_id } : {}) })
 }
 if (connector === 'stripe') for (const kind of ['deposit','refund']) {
  const record = await known(kind)
  probes.push({ target: kind, ...(record ? { path: '/v1/' + (kind === 'deposit' ? 'payment_intents' : 'refunds') + '/' + encodeURIComponent(record.external_id),
   matches: (b: Record<string, unknown>) => b.id === record.external_id && b.amount === record.amount_cents && (b.metadata as Record<string, unknown> | undefined)?.handset_outcome === record.outcome_id } : {}) })
 }
 probes.sort((a, b) => a.target.localeCompare(b.target))
 const start = cursor ? probes.findIndex(p => p.target === cursor) + 1 : 0
 if (cursor && start === 0) throw new Fault('invalid_connector_cursor')
 const selected = probes.slice(start, start + 10)
 const token = connector === 'stripe' ? env.HANDSET_STRIPE_KEY : connector === 'dial' ? env.HANDSET_DIAL_TOKEN : connector === 'orbit' ? env.HANDSET_ORBIT_TOKEN : env.HANDSET_HELPDESK_TOKEN
 let base: string | null = null
 try { base = connector === 'stripe' ? 'https://api.stripe.com' : origin(connector === 'dial' ? env.HANDSET_DIAL_ORIGIN : connector === 'orbit' ? env.HANDSET_ORBIT_ORIGIN : env.HANDSET_HELPDESK_ORIGIN, connector + '_origin') } catch { /* Report a held connection without returning installation values. */ }
 const results = await Promise.all(selected.map(async probe => {
  // Native owner and mapping withdrawal fence every outbound read, including page continuations.
  try { await env.DB.batch([ownerFence(env.DB, actor), policyFence(env, version), env.DB.prepare('DELETE FROM hnd_guard')]) }
  catch { throw new Fault('connector_authority_changed', 409) }
  let state = 'not_checked', reason = 'No receiving identity available for a read-only scope check'
  if (!base || !token) { state = 'unconfigured'; reason = 'Connector credential or valid origin is unavailable' }
  else if (probe.path) {
   const answer = await send(base + probe.path, { method: 'GET', headers: { ...bearer(token), accept: 'application/json' } })
   ;({ state, reason } = inspected(answer, probe))
  }
  return { connector, target: probe.target, mappingVersion: version, state, reason, checkedAt: Date.now() }
 }))
 await commit(env, actor, 'delivery.request', 'installation', 'completed', [policyFence(env, version), ...results.map(r =>
  env.DB.prepare('INSERT INTO hnd_delivery_checks(connector,target,mapping_version,state,reason,checked_at) VALUES (?,?,?,?,?,?)').bind(connector,r.target,version,r.state,r.reason,r.checkedAt))])
 return { observations: results, nextCursor: start + selected.length < probes.length ? selected.at(-1)!.target : null,
  mappedTargets: probes.length, effectsChanged: false, qualification: 'Read scope observed only; no write permission or remote delivery guarantee' }
}
function inspected(answer: Wire | null, probe: Probe) {
 if (!answer) return { state: 'unavailable', reason: 'Receiving readback is unavailable; retain prior delivery uncertainty' }
 if (answer.status === 401) return { state: 'credential_refused', reason: 'Receiving system refused the credential; dependent work is held' }
 if ([403,404].includes(answer.status)) return { state: 'scope_removed', reason: 'Selected receiving target is absent or outside current read scope; dependent work is held' }
 if (answer.status !== 200 || !probe.matches?.(answer.body)) return { state: 'unavailable', reason: 'Receiving readback did not match the selected mapping' }
 return { state: 'available', reason: 'Selected receiving read scope confirmed; effect authority remains separate' }
}
