import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { choice, Fault, id, integer, json, keys, owner, text, type ObjectValue } from '../core'
import { activeSourceById, sourceFence } from '../providers/sources'
import { bearer, origin, send } from '../receptionist/edge'
import { currentPolicy } from '../receptionist/store'
interface Operation { id: string; call_record_id: string; source_id: string; owner_id: string; owner_version: number; snapshot: string; state: string; decision_note: string; revision: number; created_at: number; updated_at: number }
async function assess(env: Bindings, actor: Session, value: ObjectValue) {
 keys(value, ['callRecordId'])
 const recordId = text(value.callRecordId, 'callRecordId')
 const reference = await env.DB.prepare(`SELECT o.source_id,o.external_id,r.case_id FROM hnd_source_objects o JOIN hnd_records r ON r.id=o.record_id WHERE r.id=? AND r.kind IN ('call_session','call_leg')`).bind(recordId).first<{source_id: string; external_id: string; case_id: string}>()
 if (!reference) throw new Fault('verified_call_reference_required', 409)
 const source = await activeSourceById(env, reference.source_id)
 if (!source || !env.HANDSET_TWILIO_AUTH_TOKEN) throw new Fault('source_inactive', 409)
 const wire = await send(`https://insights.twilio.com/v1/Voice/${encodeURIComponent(reference.external_id)}/Summary`, { method: 'GET', headers: { authorization: 'Basic ' + btoa(source.account_id + ':' + env.HANDSET_TWILIO_AUTH_TOKEN) } })
 let media: {state: string; tags: string[]; processingState?: string; metrics: string} = { state: 'unknown', tags: [], metrics: 'Per-leg MOS/loss/jitter qualification pending' }
 if (wire?.status === 200) {
  if (wire.body.account_sid !== source.account_id || wire.body.call_sid !== reference.external_id) throw new Fault('insights_identity_mismatch', 502)
  media = { state: 'provider_observed', tags: Array.isArray(wire.body.tags) ? wire.body.tags.filter((x): x is string => typeof x === 'string' && x.length <= 80).slice(0, 30) : [], processingState: String(wire.body.processing_state ?? 'unknown'), metrics: 'Tags only; numeric per-leg MOS/loss/jitter qualification pending' }
 }
 const policy = await currentPolicy(env.DB), orbit = env.HANDSET_ORBIT_TOKEN ? origin(env.HANDSET_ORBIT_ORIGIN, 'orbit_origin') : null
 const crm = orbit && policy?.policy.orbitTarget ? await send(`${orbit}/api/delegation/v1/check?target=${encodeURIComponent(policy.policy.orbitTarget)}`, { method: 'GET', headers: bearer(env.HANDSET_ORBIT_TOKEN) }) : null
 const connector = !crm ? 'unknown_or_unconfigured' : crm.status === 401 || crm.status === 403 ? 'scope_or_oauth_refused' : crm.status === 200 ? 'metadata_read_succeeded' : 'readback_unavailable'
 const [budgets, callbacks, uncertain] = await Promise.all([
  env.DB.prepare("SELECT id,reserved_cents,json_extract(definition,'$.budgetCents') AS budget_cents FROM hnd_grants WHERE revoked_at IS NULL AND expires_at>? AND json_extract(definition,'$.budgetCents')>0 AND reserved_cents*100>=json_extract(definition,'$.budgetCents')*80 ORDER BY reserved_cents DESC LIMIT 50").bind(Date.now()).all(),
  env.DB.prepare("SELECT id,state,due_at FROM hnd_recovery WHERE state IN ('open','human','escalated') ORDER BY due_at LIMIT 100").all(),
  env.DB.prepare("SELECT id,outcome_id,kind,state FROM hnd_rx_steps WHERE state IN ('sent','uncertain','held','rejected') ORDER BY updated_at DESC LIMIT 100").all(),
 ])
 const risks = [ ...(media.state === 'unknown' || media.tags.length ? [{ kind: 'media', evidence: { recordId, sourceId: source.id, media }, proposal: 'Review the cited media leg and test the approved continuity route; API success does not establish audio health' }] : []),
  ...(connector !== 'metadata_read_succeeded' ? [{ kind: 'connector', evidence: { connector: 'orbit', state: connector }, proposal: 'Reconnect the same scoped installation and read back pending work before retry' }] : []),
  ...(budgets.results.length ? [{ kind: 'usd_cap', evidence: budgets.results, proposal: 'Review reserved USD cents with the named owner; no automatic budget increase' }] : []),
  ...(callbacks.results.length ? [{ kind: 'callbacks', evidence: callbacks.results, proposal: 'Keep each due customer need owned while media and connector repairs are tested' }] : []),
 ]
 const snapshot = { observedAt: Date.now(), callRecordId: recordId, sourceId: source.id, api: 'This control-plane request succeeded; media health is independently observed', media, connector, nearCaps: budgets.results, pendingCallbacks: callbacks.results, uncertainSteps: uncertain.results, risks, proposalTest: 'not_run', customerOutcome: 'unconfirmed', authority: 'No route, spend, promise, publication or paging change is authorized by this assessment' }
 const key = id(), now = Date.now()
 await commit(env, actor, 'operations.assess', key, 'completed', [sourceFence(env, source), env.DB.prepare("INSERT INTO hnd_operations VALUES (?,?,?,?,?,?,'proposed','',1,?,?)").bind(key, recordId, source.id, actor.operator.id, actor.operator.version, JSON.stringify(snapshot), now, now)])
 return { id: key, revision: 1, state: 'proposed', snapshot }
}
export async function operationsDoor(request: Request, env: Bindings, actor: Session, value?: ObjectValue): Promise<Response | null> {
 const base = '/api/handset/operations', path = new URL(request.url).pathname
 if (path !== base && !path.startsWith(base + '/')) return null
 owner(actor)
 if (path === base && request.method === 'GET') return json({ assessments: (await env.DB.prepare('SELECT * FROM hnd_operations ORDER BY created_at DESC LIMIT 100').all()).results, limit: 100 })
 if (path === base + '/assess' && request.method === 'POST' && value) return json(await assess(env, actor, value), 201)
 const match = path.slice(base.length).match(/^\/([0-9a-f-]{36})\/(decision|export)$/)
 if (!match) throw new Fault('not_found', 404)
 const row = await env.DB.prepare('SELECT * FROM hnd_operations WHERE id=?').bind(match[1]).first<Operation>()
 if (!row) throw new Fault('assessment_not_found', 404)
 if (match[2] === 'export' && request.method === 'GET') {
  const snapshot = JSON.parse(row.snapshot)
  // No numbers, people, caller text, destinations, tokens or raw provider payload.
  await commit(env, actor, 'operations.export', row.id, 'completed')
  return json({ schema: 'handset.continuity-evidence/1', id: row.id, state: row.state, observedAt: snapshot.observedAt, callRecordId: row.call_record_id, sourceId: row.source_id, media: snapshot.media, connector: snapshot.connector, riskKinds: snapshot.risks.map((x: {kind: string}) => x.kind), pendingCallbackCount: snapshot.pendingCallbacks.length, uncertainStepCount: snapshot.uncertainSteps.length, publication: 'Owner-controlled Lamp handoff pending', paging: 'Independent Oncall qualification pending', receiver: 'Porthole transfer/readback pending' })
 }
 if (match[2] !== 'decision' || request.method !== 'POST' || !value) throw new Fault('method_not_allowed', 405)
 keys(value, ['revision','decision','note','confirm'])
 if (integer(value.revision, 'revision', 1) !== row.revision || row.state !== 'proposed') throw new Fault('assessment_already_decided', 409)
 if (value.confirm !== 'record exact continuity decision') throw new Fault('explicit_decision_required')
 const decision = choice(value.decision, ['approved','declined'], 'decision'), note = text(value.note, 'note', 2000)
 await commit(env, actor, 'operations.decide', row.id, 'completed', [env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_operations WHERE id=? AND revision=? AND state='proposed'").bind(row.id, row.revision),
  env.DB.prepare('UPDATE hnd_operations SET state=?,decision_note=?,revision=revision+1,updated_at=? WHERE id=?').bind(decision, note, Date.now(), row.id),
  env.DB.prepare('INSERT INTO hnd_operations_decisions VALUES (?,?,?,?,?,?,?)').bind(id(), row.id, decision, note, actor.operator.id, actor.operator.version, Date.now()),
 ])
 return json({ id: row.id, revision: row.revision + 1, state: decision, applied: false, reason: 'Decision records review only; qualified fix and bidirectional call plus callback/CRM readback required' })
}
