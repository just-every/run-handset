import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { choice, Fault, id, integer, keys, object, text, type ObjectValue } from '../core'
import type { RecordRow } from '../records/model'

export interface RuleDefinition { name: string; trigger: string; action: string; message: string; delayMinutes: number; timezone: string; startMinute: number; endMinute: number }
export interface Rule { id: string; revision: number; definition: string; state: string; owner_id: string; owner_version: number; created_at: number; updated_at: number }
interface Preview { id: string; rule_id: string; expected_revision: number; definition: string; sample_id: string; owner_id: string; owner_version: number; expires_at: number; used_at: number | null }
export const triggers = ['missed_call','disposition','callback_due'] as const
export function definition(raw: unknown): RuleDefinition {
 const v = object(raw); keys(v, ['name','trigger','action','message','delayMinutes','timezone','startMinute','endMinute'])
 const timezone = text(v.timezone, 'timezone', 80)
 try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }) } catch { throw new Fault('invalid_timezone') }
 const startMinute = integer(v.startMinute, 'startMinute', 0, 1439), endMinute = integer(v.endMinute, 'endMinute', 1, 1440)
 if (startMinute >= endMinute) throw new Fault('invalid_notice_hours')
 return { name: text(v.name, 'name', 120), trigger: choice(v.trigger, triggers, 'trigger'), action: choice(v.action, ['internal','owner_email','crank','zapier','sms'], 'action'), message: text(v.message, 'message', 4000), delayMinutes: integer(v.delayMinutes ?? 0, 'delayMinutes', 0, 10080), timezone, startMinute, endMinute }
}
export async function eventRecord(env: Bindings, key: string, trigger: string, at = Date.now()) {
 const r = await env.DB.prepare('SELECT * FROM hnd_records WHERE id=?').bind(key).first<RecordRow>()
 if (!r || !r.case_id) throw new Fault('case_linked_event_required', 409)
 const data = JSON.parse(r.data) as {direction?: string; providerStatus?: string; dueAt?: number}
 if (trigger === 'disposition' ? r.kind !== 'disposition' : trigger === 'callback_due' ? r.kind !== 'callback' || typeof data.dueAt !== 'number' || data.dueAt > at : !['call_session','call_leg','provider_attempt'].includes(r.kind) || data.direction !== 'inbound' || !['busy','no-answer','failed','canceled'].includes(data.providerStatus ?? '') || !await env.DB.prepare('SELECT record_id FROM hnd_record_sources WHERE record_id=?').bind(key).first()) throw new Fault('event_does_not_match_tested_trigger', 409)
 if (await env.DB.prepare('SELECT id FROM hnd_records WHERE supersedes_id=?').bind(key).first()) throw new Fault('event_source_superseded', 409)
 return r
}
export async function preview(env: Bindings, actor: Session, v: ObjectValue) {
 keys(v, ['definition','sampleRecordId','ruleId','expectedRevision'])
 const d = definition(v.definition), record = await eventRecord(env, text(v.sampleRecordId, 'sampleRecordId'), d.trigger)
 const key = v.ruleId ? text(v.ruleId, 'ruleId') : id(), expected = integer(v.expectedRevision ?? 0, 'expectedRevision', 0)
 const existing = await env.DB.prepare('SELECT revision FROM hnd_rules WHERE id=?').bind(key).first<{revision: number}>()
 if ((existing?.revision ?? 0) !== expected) throw new Fault('rule_revision_conflict', 409)
 const previewId = id(), expiresAt = Date.now() + 600000
 await commit(env, actor, 'automation.preview', previewId, 'completed', [env.DB.prepare('INSERT INTO hnd_rule_previews VALUES (?,?,?,?,?,?,?,?,NULL)').bind(previewId, key, expected, JSON.stringify(d), record.id, actor.operator.id, actor.operator.version, expiresAt)])
 return { previewId, ruleId: key, matched: true, recipient: d.action === 'owner_email' ? actor.operator.email : null, action: d.action, message: d.message, customerContact: 'held', effectOccurred: false, expiresAt }
}
export async function publish(env: Bindings, actor: Session, v: ObjectValue) {
 keys(v, ['previewId','confirm'])
 if (v.confirm !== 'publish exact tested rule') throw new Fault('explicit_rule_publication_required', 403)
 const p = await env.DB.prepare('SELECT * FROM hnd_rule_previews WHERE id=?').bind(text(v.previewId, 'previewId')).first<Preview>()
 if (!p || p.used_at || p.expires_at <= Date.now() || p.owner_id !== actor.operator.id || p.owner_version !== actor.operator.version) throw new Fault('fresh_own_preview_required', 403)
 const d = JSON.parse(p.definition) as RuleDefinition
 await eventRecord(env, p.sample_id, d.trigger)
 if (d.action === 'owner_email' && (actor.operator.email !== env.OWNER_EMAIL || !env.MAIL_FROM)) throw new Fault('installation_owner_mailbox_required', 403)
 const now = Date.now(), revision = p.expected_revision + 1
 const guard = env.DB.prepare(p.expected_revision ? 'INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rules WHERE id=? AND revision=?' : 'INSERT INTO hnd_guard(ok) SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_rules WHERE id=?) THEN 0 ELSE 1 END').bind(...(p.expected_revision ? [p.rule_id, p.expected_revision] : [p.rule_id]))
 await commit(env, actor, 'automation.publish', p.rule_id, 'completed', [guard,
  env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rule_previews WHERE id=? AND used_at IS NULL AND expires_at>?').bind(p.id, now),
  env.DB.prepare("INSERT INTO hnd_rules VALUES (?,?,?,'active',?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,definition=excluded.definition,state='active',owner_id=excluded.owner_id,owner_version=excluded.owner_version,updated_at=excluded.updated_at").bind(p.rule_id, revision, p.definition, actor.operator.id, actor.operator.version, now, now),
  env.DB.prepare('INSERT INTO hnd_rule_versions VALUES (?,?,?,?,?,?)').bind(p.rule_id, revision, p.definition, actor.operator.id, actor.operator.version, now),
  env.DB.prepare('UPDATE hnd_rule_previews SET used_at=? WHERE id=?').bind(now, p.id),
 ])
 return { ruleId: p.rule_id, revision, state: 'active', customerContact: 'held' }
}
export async function pause(env: Bindings, actor: Session, v: ObjectValue) {
 keys(v, ['ruleId','revision'])
 const key = text(v.ruleId, 'ruleId'), revision = integer(v.revision, 'revision', 1)
 await commit(env, actor, 'automation.pause', key, 'completed', [env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rules WHERE id=? AND revision=?').bind(key, revision),
  env.DB.prepare("UPDATE hnd_rules SET state='paused',updated_at=? WHERE id=?").bind(Date.now(), key),
  env.DB.prepare("UPDATE hnd_rule_runs SET state='canceled',reason='Rule paused before execution',updated_at=? WHERE rule_id=? AND state='queued'").bind(Date.now(), key),
 ])
 return { paused: true }
}
