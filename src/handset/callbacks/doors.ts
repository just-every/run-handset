import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, id, integer, json, keys, owner, text, timestamp, type ObjectValue } from '../core'
import { guard, sql } from '../delegation/store'
import { activeSourceById, sourceFence } from '../providers/sources'
import { callbackFence, event, policyFor, recipientHold, recoveryEvent, type Callback, type Policy } from './model'

const e164 = (value: unknown, name: string) => { const v = text(value, name, 16); if (!/^\+[1-9]\d{7,14}$/.test(v)) throw new Fault('invalid_' + name); return v }
async function writePolicy(env: Bindings, actor: Session, v: ObjectValue) {
 keys(v, ['sourceId', 'queueId', 'staffTarget', 'businessName', 'maxAttempts', 'retrySeconds', 'enabled', 'confirm'])
 if (v.confirm !== 'approve caller-requested callbacks') throw new Fault('exact_callback_policy_approval_required', 403)
 const source = await activeSourceById(env, text(v.sourceId, 'sourceId', 64))
 if (!source) throw new Fault('source_inactive', 409)
 const queueId = text(v.queueId, 'queueId', 64), prior = await env.DB.prepare('SELECT revision FROM hnd_callback_policies WHERE source_id=?').bind(source.id).first<{ revision: number }>()
 if (!await sql(env, 'SELECT 1 FROM hnd_queues WHERE id=?', queueId).first()) throw new Fault('queue_missing', 404)
 const revision = (prior?.revision ?? 0) + 1, row = [source.id, queueId, e164(v.staffTarget, 'staffTarget'), text(v.businessName, 'businessName', 120), v.enabled === false ? 0 : 1, integer(v.maxAttempts ?? 2, 'maxAttempts', 1, 3), integer(v.retrySeconds ?? 900, 'retrySeconds', 60, 86400), actor.operator.id, actor.operator.version, revision, Date.now()]
 await commit(env, actor, 'callback.policy', id(), 'completed', [sourceFence(env, source), guard(env, 'SELECT CASE WHEN COALESCE((SELECT revision FROM hnd_callback_policies WHERE source_id=?),0)=? THEN 1 ELSE 0 END', source.id, revision - 1),
  sql(env, 'INSERT INTO hnd_callback_policies VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET queue_id=excluded.queue_id,staff_target=excluded.staff_target,business_name=excluded.business_name,enabled=excluded.enabled,max_attempts=excluded.max_attempts,retry_seconds=excluded.retry_seconds,approved_by=excluded.approved_by,owner_version=excluded.owner_version,revision=excluded.revision', ...row)])
 return { sourceId: source.id, revision, enabled: row[4] === 1, dialing: 'Only for callers who asked, inside the owner-reviewed recipient hours, one claimed attempt at a time.' }
}
async function schedule(env: Bindings, actor: Session, v: ObjectValue) {
 keys(v, ['recoveryId', 'dueAt', 'evidence', 'confirm'])
 if (v.confirm !== 'the customer asked for this callback') throw new Fault('customer_request_attestation_required', 403)
 const recovery = await sql(env, 'SELECT * FROM hnd_recovery WHERE id=?', text(v.recoveryId, 'recoveryId', 64)).first<{ id: string; case_id: string; source_id: string; recipient: string; state: string; queue_place: string; call_record_id: string }>()
 if (!recovery) throw new Fault('recovery_not_found', 404)
 if (recovery.state !== 'open') throw new Fault('open_recovery_required', 409)
 const policy = await policyFor(env, recovery.source_id), source = await activeSourceById(env, recovery.source_id)
 if (!policy || !source) throw new Fault('callback_policy_required', 409)
 if (await env.DB.prepare("SELECT 1 FROM hnd_callbacks WHERE recovery_id=? AND state IN ('waiting','dialing','uncertain')").bind(recovery.id).first()) throw new Fault('callback_already_open', 409)
 const known = await recipientHold(env, recovery.recipient, Date.now())
 if (known === 'recipient_timezone_unknown_or_expired') throw new Fault('recipient_timezone_required', 409)
 const place = JSON.parse(recovery.queue_place) as { queued_at?: number; priority?: number; queue_id?: string }, now = Date.now(), key = id()
 const consent = { kind: 'owner_attested', purpose: 'callback', evidence: text(v.evidence, 'evidence', 500), attestedBy: actor.operator.id, serverTimestamp: now, marketingEnrollment: false }
 const cb: Callback = { id: key, recovery_id: recovery.id, case_id: recovery.case_id, source_id: recovery.source_id, queue_id: policy.queue_id, queue_entry_id: null, kind: 'scheduled', recipient: recovery.recipient, queued_at: place.queued_at ?? now, priority: place.priority ?? 0, due_at: timestamp(v.dueAt, 'dueAt'), state: 'waiting', attempts: 0, reason: 'Owner-scheduled callback awaiting its due time', consent: JSON.stringify(consent), owner_id: actor.operator.id, owner_version: actor.operator.version, revision: 1, created_at: now, updated_at: now }
 await commit(env, actor, 'callback.create', key, 'completed', [sourceFence(env, source), guard(env, "SELECT count(*) FROM hnd_recovery WHERE id=? AND state='open'", recovery.id),
  sql(env, `INSERT INTO hnd_callbacks(${Object.keys(cb).join(',')}) VALUES (${Object.keys(cb).map(() => '?').join(',')})`, ...Object.values(cb) as (string | number | null)[]), event(env, key, 'scheduled', { consent }, now), recoveryEvent(env, recovery.id, 'callback_scheduled', { callbackId: key, dueAt: cb.due_at }, actor.operator.id, now)])
 return { callback: cb }
}
async function change(env: Bindings, actor: Session, cb: Callback, op: string, v: ObjectValue) {
 keys(v, ['revision', 'note', 'outcome'])
 if (integer(v.revision, 'revision', 1) !== cb.revision) throw new Fault('callback_revision_conflict', 409)
 const note = text(v.note, 'note', 1000), now = Date.now()
 let state: string, reason: string
 if (op === 'cancel') {
  if (!['waiting', 'uncertain'].includes(cb.state)) throw new Fault('callback_not_cancellable', 409)
  state = 'cancelled'; reason = 'Cancelled by the named owner: ' + note
 } else {
  if (cb.state !== 'uncertain') throw new Fault('uncertain_attempt_required', 409)
  const outcome = text(v.outcome, 'outcome', 20)
  if (!['not_placed', 'placed'].includes(outcome)) throw new Fault('invalid_outcome')
  state = outcome === 'not_placed' ? 'waiting' : 'unanswered'; reason = `Owner resolved the uncertain attempt as ${outcome}: ${note}`
 }
 await commit(env, actor, 'callback.change', cb.id, 'completed', [callbackFence(env, cb),
  sql(env, 'UPDATE hnd_callbacks SET state=?,reason=?,due_at=CASE WHEN ?=\'waiting\' THEN ? ELSE due_at END,revision=revision+1,updated_at=? WHERE id=?', state, reason, state, now, now, cb.id),
  sql(env, "UPDATE hnd_callback_attempts SET state=CASE WHEN state='uncertain' THEN 'failed' ELSE state END,reason=CASE WHEN state='uncertain' THEN ? ELSE reason END,ended_at=COALESCE(ended_at,?) WHERE callback_id=?", 'owner resolved: ' + note, now, cb.id), event(env, cb.id, op, { note, state, previous: cb.state, actor: actor.operator.id }, now)])
 return { callback: await sql(env, 'SELECT * FROM hnd_callbacks WHERE id=?', cb.id).first<Callback>() }
}
export async function callbackDoor(request: Request, env: Bindings, actor: Session, value?: ObjectValue): Promise<Response | null> {
 const path = new URL(request.url).pathname, base = '/api/handset/callbacks'
 if (path !== base && !path.startsWith(base + '/')) return null
 owner(actor)
 if (path === base && request.method === 'GET') {
  const callbacks = (await sql(env, "SELECT c.*,(SELECT count(*) FROM hnd_callbacks o WHERE o.source_id=c.source_id AND o.state='waiting' AND (o.priority>c.priority OR (o.priority=c.priority AND (o.queued_at<c.queued_at OR (o.queued_at=c.queued_at AND o.rowid<c.rowid))))) AS ahead FROM hnd_callbacks c ORDER BY c.priority DESC,c.queued_at,c.rowid LIMIT 200").all()).results
  return json({ policies: (await sql(env, 'SELECT * FROM hnd_callback_policies ORDER BY created_at LIMIT 50').all()).results, callbacks,
   attempts: (await sql(env, 'SELECT * FROM hnd_callback_attempts ORDER BY claimed_at DESC LIMIT 400').all()).results,
   events: (await sql(env, 'SELECT * FROM hnd_callback_events ORDER BY occurred_at DESC LIMIT 400').all()).results,
   sources: (await sql(env, "SELECT s.id,json_extract(n.data,'$.e164') AS e164 FROM hnd_sources s JOIN hnd_records n ON n.id=s.number_id WHERE s.revoked_at IS NULL ORDER BY s.created_at LIMIT 20").all()).results,
   queues: (await sql(env, 'SELECT id,name FROM hnd_queues ORDER BY name LIMIT 100').all()).results,
   recoveries: (await sql(env, "SELECT id,recipient,state FROM hnd_recovery WHERE state='open' ORDER BY due_at LIMIT 100").all()).results })
 }
 if (request.method !== 'POST' || !value) throw new Fault('method_not_allowed', 405)
 if (path === base + '/policies') return json(await writePolicy(env, actor, value), 201)
 if (path === base) return json(await schedule(env, actor, value), 201)
 const m = path.match(/^\/api\/handset\/callbacks\/([0-9a-f-]{36})\/(cancel|resolve-uncertain)$/)
 if (!m) throw new Fault('not_found', 404)
 const cb = await sql(env, 'SELECT * FROM hnd_callbacks WHERE id=?', m[1]).first<Callback>()
 if (!cb) throw new Fault('callback_not_found', 404)
 return json(await change(env, actor, cb, m[2], value))
}
export type { Policy }
