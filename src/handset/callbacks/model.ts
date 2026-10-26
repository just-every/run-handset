import type { Bindings } from '../../auth.server'
import { id } from '../core'
import { guard } from '../delegation/store'
import { presenceFreshMs } from '../queues/model'

export const root = '/providers/twilio/callbacks'
export interface Policy { source_id: string; queue_id: string; staff_target: string; business_name: string; enabled: number; max_attempts: number; retry_seconds: number; approved_by: string; owner_version: number; revision: number; created_at: number }
export interface Callback { id: string; recovery_id: string; case_id: string; source_id: string; queue_id: string | null; queue_entry_id: string | null; kind: 'virtual_hold' | 'scheduled'; recipient: string; queued_at: number; priority: number; due_at: number; state: string; attempts: number; reason: string; consent: string; owner_id: string; owner_version: number; revision: number; created_at: number; updated_at: number }
export interface Attempt { id: string; callback_id: string; attempt_no: number; state: string; provider_sid: string | null; reason: string; claimed_at: number; ended_at: number | null }

const current = `p.enabled=1 AND o.role='owner' AND o.status='active' AND o.version=p.owner_version`
export const policyFor = (env: Bindings, sourceId: string) => env.DB.prepare(`SELECT p.* FROM hnd_callback_policies p JOIN oa_operators o ON o.id=p.approved_by WHERE p.source_id=? AND ${current}`).bind(sourceId).first<Policy>()
export const policyFence = (env: Bindings, p: Pick<Policy, 'source_id' | 'revision'>) => guard(env, `SELECT count(*) FROM hnd_callback_policies p JOIN oa_operators o ON o.id=p.approved_by WHERE p.source_id=? AND p.revision=? AND ${current}`, p.source_id, p.revision)
export const callbackFence = (env: Bindings, c: Pick<Callback, 'id' | 'revision'>) => guard(env, 'SELECT count(*) FROM hnd_callbacks WHERE id=? AND revision=?', c.id, c.revision)
export const noVoiceStop = (env: Bindings, recipient: string, numberId: string) => guard(env, "SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_protection_stops WHERE recipient=? AND (number_id=? OR reason='dnc') AND channel IN ('voice','all')) THEN 0 ELSE 1 END", recipient, numberId)
export const isStopped = async (env: Bindings, recipient: string, numberId: string) => !!await env.DB.prepare("SELECT id FROM hnd_protection_stops WHERE recipient=? AND (number_id=? OR reason='dnc') AND channel IN ('voice','all') LIMIT 1").bind(recipient, numberId).first()
export const event = (env: Bindings, callbackId: string, kind: string, evidence: unknown, at = Date.now()) => env.DB.prepare('INSERT INTO hnd_callback_events VALUES (?,?,?,?,?)').bind(id(), callbackId, kind, JSON.stringify(evidence), at)
export const recoveryEvent = (env: Bindings, recoveryId: string, kind: string, evidence: unknown, actor: string, at = Date.now()) => env.DB.prepare('INSERT INTO hnd_recovery_events VALUES (?,?,?,?,?,?)').bind(id(), recoveryId, kind, JSON.stringify(evidence), actor, at)

/** The owner-reviewed recipient window shared with the text-back gates: unknown, expired or stale review holds the call. */
export async function recipientHold(env: Bindings, recipient: string, at: number): Promise<string | null> {
 const row = await env.DB.prepare(`SELECT r.* FROM hnd_text_recipients r JOIN oa_operators o ON o.id=r.approved_by WHERE r.recipient=? AND r.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=r.owner_version`).bind(recipient, at).first<{ timezone: string; start_minute: number; end_minute: number }>()
 if (!row) return 'recipient_timezone_unknown_or_expired'
 const parts = new Intl.DateTimeFormat('en-US', { timeZone: row.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
 const minute = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value)
 return minute < row.start_minute || minute >= row.end_minute ? 'recipient_quiet_hours' : null
}
/** Agents who could take a call right now in this queue; each in-flight callback and each live waiting caller occupies one. */
export async function freeAgents(env: Bindings, queueId: string, sourceId: string, at: number) {
 const agents = await env.DB.prepare(`SELECT count(*) AS n FROM hnd_queue_agents a JOIN hnd_queue_memberships m ON m.operator_id=a.operator_id JOIN oa_operators o ON o.id=a.operator_id WHERE m.queue_id=? AND m.logged_in=1 AND a.availability='available' AND a.heartbeat_at>? AND a.wrap_until<=? AND o.status='active' AND NOT EXISTS(SELECT 1 FROM hnd_queue_reservations r WHERE r.agent_id=a.operator_id)`).bind(queueId, at - presenceFreshMs, at).first<{ n: number }>()
 const busy = await env.DB.prepare("SELECT (SELECT count(*) FROM hnd_callbacks WHERE source_id=? AND state IN ('dialing','uncertain')) + (SELECT count(*) FROM hnd_queue_entries WHERE queue_id=? AND state IN ('waiting','reserved')) AS n").bind(sourceId, queueId).first<{ n: number }>()
 return Math.max(0, (agents?.n ?? 0) - (busy?.n ?? 0))
}
