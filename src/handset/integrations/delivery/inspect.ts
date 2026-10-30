import type { Bindings } from '../../../auth.server'
import type { Session } from '../../../modules/operator-auth/index.mjs'
import { commit } from '../../audit/store'
import { choice, Fault, integer, keys, ownerFence, text, type ObjectValue } from '../../core'
import { bearer, send, type Wire } from '../../receptionist/edge'
import { currentPolicy } from '../../receptionist/store'
import { receivingConnection } from './connection'

const families = ['dial','stripe','orbit','helpdesk'] as const
interface Probe { target: string; path?: string; matches?: (body: Record<string, unknown>) => boolean; delivery?: { record: Known; path: string; matches: (body: Record<string, unknown>) => boolean } }
interface Known { id: string; external_id: string | null; outcome_id: string; amount_cents: number; call_id: string; request: string; created_at: number }
const policyFence = (env: Bindings, version: number) => env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT CASE WHEN (SELECT max(version) FROM hnd_rx_policy)=? THEN 1 ELSE 0 END').bind(version)
/** Explicit owner inspection reads only native selected targets; it cannot settle or replay an effect. */
export async function inspectConnector(env: Bindings, actor: Session, value: ObjectValue) {
 keys(value, ['connector','mappingVersion','cursor','confirm'])
 if (value.confirm !== 'inspect current connector read scope') throw new Fault('explicit_connector_inspection_required', 403)
 const connector = choice(value.connector, families, 'connector'), current = await currentPolicy(env.DB)
 const version = integer(value.mappingVersion, 'mappingVersion', 1)
 if (!current || version !== current.version) throw new Fault('connector_mapping_changed', 409)
 const cursor = value.cursor === undefined ? '' : text(value.cursor, 'cursor', 300)
 const known = async (kind: string, field?: string, target?: string) => env.DB.prepare(`SELECT s.id,s.external_id,s.outcome_id,s.amount_cents,s.request,s.created_at,o.call_id
  FROM hnd_rx_steps s JOIN hnd_rx_outcomes o ON o.id=s.outcome_id WHERE s.kind=? AND s.state IN ('sent','uncertain','confirmed')
  AND (s.external_id IS NOT NULL OR s.kind IN ('crm','support'))
  AND o.policy_version=? AND (? IS NULL OR json_extract(s.request,?)=?) ORDER BY s.created_at DESC,s.id DESC LIMIT 1`)
  .bind(kind, version, field ?? null, '$.' + (field ?? 'serviceId'), target ?? null).first<Known>()
 const probes: Probe[] = []
 if (connector === 'orbit' && current.policy.orbitTarget) {
  const target = current.policy.orbitTarget, record = await known('crm', 'target', target)
  probes.push({ target, path: '/api/delegation/v1/check?target=' + encodeURIComponent(target),
   matches: b => Number.isSafeInteger(b.revision) && Number.isSafeInteger(b.audienceRevision),
   ...(record ? { delivery: { record, path: '/api/delegation/v1/effects/' + encodeURIComponent(`handset-${record.outcome_id}-crm`),
    matches: b => { const h = b.handoff as Record<string, unknown> | undefined; return h?.target === target && h.content === JSON.parse(record.request).content } } } : {}) })
 }
 if (connector === 'helpdesk') for (const target of new Set(current.policy.supportConversations?.map(m => m.conversationId) ?? [])) {
  const record = await known('support', 'conversationId', target), path = '/api/v1/conversations/' + encodeURIComponent(target)
  probes.push({ target, path, matches: b => b.id === target && Number.isSafeInteger(b.revision),
   ...(record ? { delivery: { record, path: path + '/messages', matches: b => {
    if (!Array.isArray(b.data) || b.next_cursor !== null) return false
    const messages = (b.data as Record<string, unknown>[]).filter(m => m.localId === `handset-${record.outcome_id}-support`)
    return messages.length === 1 && typeof messages[0].id === 'string' && (!record.external_id || messages[0].id === record.external_id) && messages[0].content === JSON.parse(record.request).content
   } } } : {}) })
 }
 if (connector === 'dial') for (const service of current.policy.services) {
  const record = await known('booking', 'serviceId', service.id)
  const matches = (b: Record<string, unknown>) => b.id === record?.external_id && b.eventTypeId === service.eventTypeId && (b.answers as Record<string, unknown> | undefined)?.handsetCall === record?.call_id
  const path = record?.external_id ? '/api/app/bookings/' + encodeURIComponent(record.external_id) : null
  probes.push({ target: service.id, ...(record && path ? { path, matches, delivery: { record, path,
   matches: b => matches(b) && b.state === 'confirmed' && Date.parse(String(b.startAt)) === Date.parse(JSON.parse(record.request).startAt) } } : {}) })
 }
 if (connector === 'stripe') for (const kind of ['deposit','refund']) {
  const record = await known(kind)
  const matches = (b: Record<string, unknown>) => b.id === record?.external_id && b.amount === record?.amount_cents && (b.metadata as Record<string, unknown> | undefined)?.handset_outcome === record?.outcome_id
  const path = record?.external_id ? '/v1/' + (kind === 'deposit' ? 'payment_intents' : 'refunds') + '/' + encodeURIComponent(record.external_id) : null
  probes.push({ target: kind, ...(record && path ? { path, matches, delivery: { record, path,
   matches: b => matches(b) && b.status === 'succeeded' && (kind === 'refund' || b.currency === 'usd' && b.amount_received === record.amount_cents) } } : {}) })
 }
 probes.sort((a, b) => a.target.localeCompare(b.target))
 const start = cursor ? probes.findIndex(p => p.target === cursor) + 1 : 0
 if (cursor && start === 0) throw new Fault('invalid_connector_cursor')
 const selected = probes.slice(start, start + 10)
 const connection = await receivingConnection(env, connector), { base, token } = connection
 const fence = async () => {
  try { await env.DB.batch([ownerFence(env.DB, actor), policyFence(env, version), env.DB.prepare('DELETE FROM hnd_guard')]) }
  catch { throw new Fault('connector_authority_changed', 409) }
 }
 const results = await Promise.all(selected.map(async probe => {
  // Native owner and mapping withdrawal fence every outbound read, including page continuations.
  await fence()
  let state = 'not_checked', reason = 'No receiving identity available for a read-only scope check'
  let deliveryState = probe.delivery ? 'pending' : 'not_checked'
  if (!base || !token) { state = 'unconfigured'; reason = 'Connector credential or valid origin is unavailable' }
  else if (probe.path) {
   const answer = await send(base + probe.path, { method: 'GET', headers: { ...bearer(token), accept: 'application/json' } })
   ;({ state, reason } = inspected(answer, probe))
   if (state === 'available' && probe.delivery) {
    await fence()
    const receipt = probe.delivery.path === probe.path ? answer : await send(base + probe.delivery.path, { method: 'GET', headers: { ...bearer(token), accept: 'application/json' } })
    if (receipt?.status === 200 && probe.delivery.matches(receipt.body)) deliveryState = 'confirmed'
    else if (receipt?.status === 401 || receipt?.status === 403) ({ state, reason } = inspected(receipt, probe))
   }
  }
  const checkedAt = Date.now(), record = probe.delivery?.record
  const first = record && deliveryState === 'confirmed' ? await env.DB.prepare(`SELECT MIN(checked_at) AS at FROM hnd_delivery_checks
   WHERE connector=? AND target=? AND mapping_version=? AND connection_key=? AND step_id=? AND delivery_state='confirmed'`)
   .bind(connector, probe.target, version, connection.key, record.id).first<{ at: number | null }>() : null
  const confirmedAt = deliveryState === 'confirmed' ? first?.at ?? checkedAt : null
  return { connector, target: probe.target, mappingVersion: version, state, reason, checkedAt,
   delivery: { state: deliveryState, stepId: record?.id ?? null, startedAt: record?.created_at ?? null, confirmedAt,
    lagMs: confirmedAt === null || !record ? null : Math.max(0, confirmedAt - record.created_at),
    pendingAgeMs: record && deliveryState === 'pending' ? Math.max(0, checkedAt - record.created_at) : null } }
 }))
 await commit(env, actor, 'delivery.request', 'installation', 'completed', [policyFence(env, version), ...results.map(r =>
  env.DB.prepare(`INSERT INTO hnd_delivery_checks(connector,target,mapping_version,state,reason,checked_at,connection_key,step_id,delivery_state,delivery_started_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(connector,r.target,version,r.state,r.reason,r.checkedAt,connection.key,r.delivery.stepId,r.delivery.state,r.delivery.startedAt))])
 return { observations: results, nextCursor: start + selected.length < probes.length ? selected.at(-1)!.target : null,
  mappedTargets: probes.length, effectsChanged: false, qualification: 'Exact receiving readback only; observed lag ends at first matching read, not a remote health guarantee or customer read receipt' }
}
function inspected(answer: Wire | null, probe: Probe) {
 if (!answer) return { state: 'unavailable', reason: 'Receiving readback is unavailable; retain prior delivery uncertainty' }
 if (answer.status === 401) return { state: 'credential_refused', reason: 'Receiving system refused the credential; dependent work is held' }
 if ([403,404].includes(answer.status)) return { state: 'scope_removed', reason: 'Selected receiving target is absent or outside current read scope; dependent work is held' }
 if (answer.status !== 200 || !probe.matches?.(answer.body)) return { state: 'unavailable', reason: 'Receiving readback did not match the selected mapping' }
 return { state: 'available', reason: 'Selected receiving read scope confirmed; effect authority remains separate' }
}
