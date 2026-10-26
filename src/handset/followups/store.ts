import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { digest, Fault, id, integer, keys, text, timestamp, type ObjectValue } from '../core'
import type { RecordRow } from '../records/model'
import { orbitHandoff } from '../receptionist/orbit'
import { bearer, origin, send } from '../receptionist/edge'

export interface Followup {
 id: string; case_id: string; source_id: string; source_hash: string; case_version: number;
 owner_id: string; owner_version: number; obligation: string; due_at: number; confirmation_basis: string;
 target: string; draft: string; revision: number; approved_revision: number | null; approved_by: string | null;
 approved_owner_version: number | null; status: string; delivery: string; operation_key: string;
 readback: string | null; reason: string; next_due_at: number; created_at: number; updated_at: number
}
export const get = async (db: D1Database, key: string) => {
 const row = await db.prepare('SELECT * FROM hnd_followups WHERE id=?').bind(key).first<Followup>()
 if (!row) throw new Fault('followup_not_found', 404)
 return row
}
const sourceHash = (s: RecordRow) => digest([s.id, s.case_id, s.parent_id, s.data])
async function source(env: Bindings, sourceId: string, caseId: string) {
 const s = await env.DB.prepare("SELECT * FROM hnd_records WHERE id=? AND case_id=? AND kind IN ('promise','transcript','disposition')").bind(sourceId, caseId).first<RecordRow>()
 if (!s) throw new Fault('cited_source_required', 409)
 if (await env.DB.prepare('SELECT id FROM hnd_records WHERE supersedes_id=?').bind(s.id).first()) throw new Fault('source_superseded', 409)
 return s
}
function sourceFence(env: Bindings, row: Followup) {
 return env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_records r JOIN hnd_cases c ON c.id=r.case_id
 WHERE r.id=? AND c.id=? AND c.version=? AND NOT EXISTS(SELECT 1 FROM hnd_records n WHERE n.supersedes_id=r.id)`)
 .bind(row.source_id, row.case_id, row.case_version)
}
const versionFence = (env: Bindings, row: Followup) => env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_followups WHERE id=? AND revision=?').bind(row.id, row.revision)
const ownerFence = (env: Bindings, row: Followup) => env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND role='owner' AND status='active'").bind(row.owner_id, row.owner_version)
async function fresh(env: Bindings, row: Followup) {
 const s = await source(env, row.source_id, row.case_id)
 const c = await env.DB.prepare('SELECT version FROM hnd_cases WHERE id=?').bind(row.case_id).first<{version: number}>()
 if (!c || c.version !== row.case_version || await sourceHash(s) !== row.source_hash) throw new Fault('promise_changed_review_again', 409)
 return s
}
async function update(env: Bindings, actor: Session, row: Followup, patch: Partial<Followup>, fences: D1PreparedStatement[] = []) {
 const next = { ...row, ...patch, revision: row.revision + 1, updated_at: Date.now() }
 const columns = ['status','delivery','reason','readback','approved_revision','approved_by','approved_owner_version','draft','due_at','next_due_at','owner_id','owner_version'] as const
 await commit(env, actor, 'followup.change', row.id, next.delivery === 'uncertain' ? 'uncertain' : 'completed', [
  versionFence(env, row), ...fences,
  env.DB.prepare(`UPDATE hnd_followups SET ${columns.map(c => c + '=?').join(',')},revision=?,updated_at=? WHERE id=?`).bind(...columns.map(c => next[c]), next.revision, next.updated_at, row.id),
  env.DB.prepare('INSERT INTO hnd_followup_history VALUES (?,?,?,?,?)').bind(row.id, next.revision, JSON.stringify(next), actor.operator.id, next.updated_at),
 ])
 return get(env.DB, row.id)
}
export async function create(env: Bindings, actor: Session, v: ObjectValue) {
 const made = await prepare(env, actor.operator, v)
 if (made.replay) return made
 await commit(env, actor, 'followup.create', made.followup.id, 'completed', made.statements)
 return { followup: made.followup, replay: false }
}
/** The checks and writes of a new cited follow-up, for the native API above and the demo's own samples. */
export async function prepare(env: Bindings, owner: { id: string; version: number }, v: ObjectValue): Promise<{ followup: Followup; replay: true } | { followup: Followup; replay: false; statements: D1PreparedStatement[] }> {
 keys(v, ['caseId','sourceId','obligation','dueAt','confirmationBasis','target','draft'])
 const caseId = text(v.caseId, 'caseId'), s = await source(env, text(v.sourceId, 'sourceId'), caseId)
 const obligation = text(v.obligation, 'obligation', 2000), draft = text(v.draft, 'draft', 4000)
 // A selected source must actually contain the quoted obligation. This is extraction, not an invented commitment.
 if (!String(JSON.parse(s.data).text ?? '').includes(obligation)) throw new Fault('obligation_not_in_cited_source', 409)
 const target = text(v.target, 'target', 200)
 if (!/^opportunities\/[A-Za-z0-9_-]+\/handoffs\/[A-Za-z0-9_-]+$/.test(target)) throw new Fault('selected_orbit_handoff_required')
 const old = await env.DB.prepare('SELECT * FROM hnd_followups WHERE source_id=?').bind(s.id).first<Followup>()
 const due = timestamp(v.dueAt, 'dueAt'), basis = text(v.confirmationBasis, 'confirmationBasis', 1000)
 if (old) {
  if (old.obligation !== obligation || old.target !== target || old.draft !== draft || old.due_at !== due || old.confirmation_basis !== basis) throw new Fault('promise_replay_conflict', 409)
  return { followup: old, replay: true }
 }
 const c = await env.DB.prepare('SELECT version FROM hnd_cases WHERE id=?').bind(caseId).first<{version: number}>()
 if (!c) throw new Fault('case_not_found', 404)
 const now = Date.now(), followupId = id(), operationKey = id()
 const row: Followup = { id: followupId, case_id: caseId, source_id: s.id, source_hash: await sourceHash(s), case_version: c.version,
  owner_id: owner.id, owner_version: owner.version, obligation, due_at: due, confirmation_basis: basis,
  target, draft, revision: 1, approved_revision: null, approved_by: null, approved_owner_version: null, status: 'open',
  delivery: 'draft', operation_key: operationKey, readback: null, reason: '', next_due_at: due, created_at: now, updated_at: now }
 return { followup: row, replay: false, statements: [sourceFence(env, row),
  env.DB.prepare(`INSERT INTO hnd_followups(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)),
  env.DB.prepare('INSERT INTO hnd_followup_history VALUES (?,?,?,?,?)').bind(row.id, 1, JSON.stringify(row), owner.id, now),
 ] }
}
export async function action(env: Bindings, actor: Session, row: Followup, op: string, v: ObjectValue) {
 if (integer(v.revision, 'revision', 1) !== row.revision) throw new Fault('followup_revision_conflict', 409)
 if (op === 'cancel' || op === 'decline') {
  keys(v, ['revision','note'])
  const reason = text(v.note, 'note', 1000)
  return update(env, actor, row, { status: op === 'decline' ? 'declined' : 'canceled', delivery: ['draft','approved','held'].includes(row.delivery) ? 'canceled' : row.delivery, reason })
 }
 if (row.status !== 'open') throw new Fault('followup_not_open', 409)
 if (op === 'edit') {
  keys(v, ['revision','draft','dueAt'])
  if (!['draft','approved','held'].includes(row.delivery)) throw new Fault('started_effect_requires_reconciliation', 409)
  return update(env, actor, row, { draft: text(v.draft, 'draft', 4000), due_at: timestamp(v.dueAt, 'dueAt'), next_due_at: timestamp(v.dueAt, 'dueAt'), delivery: 'draft', approved_revision: null, approved_by: null, approved_owner_version: null, reason: 'Human edit requires fresh exact approval' })
 }
 keys(v, ['revision','confirm'])
 if (op === 'approve') {
  if (v.confirm !== 'approve exact cited handoff') throw new Fault('explicit_approval_required')
  if (!['draft','held'].includes(row.delivery)) throw new Fault('followup_not_draft', 409)
  await fresh(env, row)
  return update(env, actor, row, { delivery: 'approved', approved_revision: row.revision + 1, approved_by: actor.operator.id, approved_owner_version: actor.operator.version, reason: 'Exact internal Orbit handoff approved; customer contact remains held' }, [sourceFence(env, row), ownerFence(env, row)])
 }
 if (op === 'deliver') {
  await fresh(env, row)
  if (row.delivery !== 'approved' || row.approved_revision !== row.revision || row.approved_by !== actor.operator.id || row.approved_owner_version !== actor.operator.version) throw new Fault('exact_handoff_approval_required', 403)
  const claimed = await update(env, actor, row, { delivery: 'sending', reason: 'Started: reconcile before any further write' }, [sourceFence(env, row), ownerFence(env, row)])
  // Orbit's documented operationKey is replay safe. We still never blindly resend a started write.
  const result = await orbitHandoff(env, claimed.target, claimed.operation_key, content(claimed), async () => { await commit(env, actor, 'followup.change', claimed.id, 'completed', [versionFence(env, claimed), sourceFence(env, claimed), ownerFence(env, claimed)]) })
  return update(env, actor, claimed, { delivery: result.state === 'confirmed' ? 'received' : result.state === 'held' || result.state === 'rejected' ? 'held' : 'uncertain', reason: result.reason, readback: result.readback ? JSON.stringify(result.readback) : null })
 }
 if (op === 'reconcile') { await fresh(env, row); return reconcile(env, actor, row) }
 throw new Fault('not_found', 404)
}
export const content = (row: Followup) => `${row.obligation}\nOwner: ${row.owner_id}\nDue: ${new Date(row.due_at).toISOString()}\nConfirmation: ${row.confirmation_basis}\nHandset case: ${row.case_id}\nSource: ${row.source_id}\nDraft: ${row.draft}`
/** Reconciliation reads receipts and CURRENT owning-system state. An immutable write receipt is never completion. */
async function reconcile(env: Bindings, actor: Session, row: Followup) {
 if (!['sending','uncertain','received'].includes(row.delivery)) throw new Fault('no_started_handoff', 409)
 const o = env.HANDSET_ORBIT_TOKEN ? origin(env.HANDSET_ORBIT_ORIGIN, 'orbit_origin') : null
 if (!o) return update(env, actor, row, { reason: 'orbit_connector_unconfigured' })
 const headers = bearer(env.HANDSET_ORBIT_TOKEN)
 const receipt = await send(`${o}/api/delegation/v1/effects/${encodeURIComponent(row.operation_key)}`, { method: 'GET', headers })
 if (!receipt || receipt.status !== 200 || (receipt.body.handoff as {content?: string} | undefined)?.content !== content(row)) return update(env, actor, row, { reason: receipt?.status === 401 || receipt?.status === 403 ? 'orbit_scope_or_oauth_refused; reconnect and repair' : 'receipt_unavailable_or_mismatched; no replay' })
 const observed = await send(`${o}/api/delegation/v1/check?target=${encodeURIComponent(row.target)}`, { method: 'GET', headers: { ...headers, 'X-RER-Record-State-Schema': 'crm.handoff-state/1' } })
 const state = observed?.body.recordState as {schema?: string; kind?: string; state?: string} | undefined
 if (!observed || observed.status !== 200 || state?.schema !== 'crm.handoff-state/1' || state.kind !== 'crm.handoff' || !['open','completed','cancelled'].includes(state.state ?? '')) return update(env, actor, row, { delivery: 'received', reason: 'Current completion state unavailable; promise remains open' })
 return update(env, actor, row, { delivery: 'received', status: state.state === 'completed' ? 'confirmed' : state.state === 'cancelled' ? 'declined' : 'open', reason: 'Current Orbit handoff state read back', readback: JSON.stringify({ operationKey: row.operation_key, target: row.target, observedAt: Date.now(), revision: observed.body.revision, recordState: state }) }, [ownerFence(env, row), sourceFence(env, row)])
}
export async function listing(env: Bindings) {
 const rows = (await env.DB.prepare('SELECT * FROM hnd_followups ORDER BY due_at,id LIMIT 200').all<Followup>()).results
 const now = Date.now()
 return { followups: rows, counts: { confirmed: rows.filter(r => r.status === 'confirmed').length, declined: rows.filter(r => r.status === 'declined').length, due: rows.filter(r => r.status === 'open' && r.due_at <= now).length, open: rows.filter(r => r.status === 'open').length }, truncated: rows.length === 200 }
}
