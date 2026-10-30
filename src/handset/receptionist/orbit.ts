import type { Bindings } from '../../auth.server'
import { origin, send, bearer, held, rejected, uncertain, type EdgeResult } from './edge'

// Orbit delegation protocol rer-delegation/1: one `orbit.handoff.upsert` effect per
// operationKey, under the owner-selected opportunity handoff. Orbit keeps contacts and deals.
const base = (env: Bindings) => env.HANDSET_ORBIT_TOKEN ? origin(env.HANDSET_ORBIT_ORIGIN, 'orbit_origin') : null
export async function orbitHandoff(env: Bindings, target: string, operationKey: string, content: string, beforeEffect: () => Promise<void> = async () => {}): Promise<EdgeResult> {
 const o = base(env)
 if (!o) return held('orbit_connector_unconfigured')
 if (!target) return held('orbit_target_unselected')
 const headers = { ...bearer(env.HANDSET_ORBIT_TOKEN), 'content-type': 'application/json' }
 const receipt = async (): Promise<EdgeResult> => {
  const read = await send(`${o}/api/delegation/v1/effects/${encodeURIComponent(operationKey)}`, { method: 'GET', headers })
  if (!read) return uncertain('orbit_readback_unavailable')
  if (read.status === 401) return uncertain('orbit_credential_refused')
  if (read.status === 403) return uncertain('orbit_target_out_of_scope')
  const handoff = (read.body.handoff ?? {}) as Record<string, unknown>
  if (read.status !== 200 || handoff.target !== target || handoff.content !== content) return uncertain('orbit_readback_mismatch')
  return { state: 'confirmed', externalId: operationKey, readback: { operationKey, target, content: handoff.content }, reason: 'readback_matched' }
 }
 const existing = await receipt()
 if (existing.state === 'confirmed' || ['orbit_credential_refused', 'orbit_target_out_of_scope'].includes(existing.reason)) return existing
 for (let attempt = 0; attempt < 2; attempt++) {
  const check = await send(`${o}/api/delegation/v1/check?target=${encodeURIComponent(target)}`, { method: 'GET', headers })
  if (!check) return uncertain('orbit_check_unavailable')
  if (check.status === 401) return rejected('orbit_credential_refused')
  if (check.status === 404 || check.status === 403) return rejected('orbit_target_out_of_scope')
  if (check.status !== 200) return uncertain('orbit_answer_unrecognised')
  await beforeEffect()
  const wire = await send(`${o}/api/delegation/v1/effects`, { method: 'POST', headers, body: JSON.stringify({ operation: 'orbit.handoff.upsert', operationKey, target, expectedRevision: check.body.revision, expectedAudienceRevision: check.body.audienceRevision, content }) })
  if (!wire) return uncertain('orbit_response_lost')
  if ([200, 201].includes(wire.status)) return receipt()
  const code = String((wire.body.error as { code?: string } | undefined)?.code ?? '')
  if (wire.status === 409 && ['REVISION_CONFLICT', 'AUDIENCE_CHANGED'].includes(code) && attempt === 0) continue
  if (wire.status === 401 || wire.status === 403) return rejected('orbit_credential_refused')
  return wire.status >= 400 && wire.status < 500 ? rejected('orbit_' + (code.toLowerCase() || 'refused')) : uncertain('orbit_answer_unrecognised')
 }
 return uncertain('orbit_revision_conflict_unsettled')
}
