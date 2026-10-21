import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { digest, id, policy, ownerFence, Fault } from '../core'

export interface AuditRow {
 sequence: number; id: string; actor: string; action: string; policy: string; subject: string; outcome: string;
 occurred_at: number; previous_hash: string; hash: string
}
export const zero = '0'.repeat(64)
export const auditBody = (row: Omit<AuditRow, 'hash'>) => [row.sequence, row.id, row.actor, row.action, row.policy, row.subject, row.outcome, row.occurred_at, row.previous_hash]
export async function actorRef(db: D1Database, operatorId: string) {
 await db.prepare('INSERT INTO hnd_actor_refs(operator_id,pseudonym) VALUES (?,?) ON CONFLICT DO NOTHING').bind(operatorId, id()).run()
 return (await db.prepare('SELECT pseudonym FROM hnd_actor_refs WHERE operator_id=?').bind(operatorId).first<{pseudonym:string}>())!.pseudonym
}
export async function commit(env: Bindings, actor: Session, action: string, subject: string, outcome: string, statements: D1PreparedStatement[] = [], fence = true) {
 return append(env, await actorRef(env.DB, actor.operator.id), action, subject, outcome, [...(fence ? [ownerFence(env.DB,actor)] : []), ...statements])
}
export async function append(env: Bindings, pseudonym: string, action: string, subject: string, outcome: string, statements: D1PreparedStatement[] = []) {
 if (!actions.includes(action) || !['completed','refused','failed'].includes(outcome) || !(subject === 'installation' || /^[0-9a-f-]{36}$/.test(subject))) throw new Error('Invalid server audit event')
 const db = env.DB
 for (let retry = 0; retry < 8; retry++) {
  const last = await db.prepare('SELECT sequence,hash FROM hnd_audit ORDER BY sequence DESC LIMIT 1').first<{sequence:number;hash:string}>()
  const row = { sequence: (last?.sequence ?? 0) + 1, id: id(), actor: pseudonym, action, policy, subject, outcome, occurred_at: Date.now(), previous_hash: last?.hash ?? zero }
  const hash = await digest(auditBody(row))
  try {
   await db.batch([
    ...statements,
    db.prepare('INSERT INTO hnd_audit VALUES (?,?,?,?,?,?,?,?,?,?)').bind(row.sequence, row.id, row.actor, row.action, row.policy, row.subject, row.outcome, row.occurred_at, row.previous_hash, hash),
    db.prepare('DELETE FROM hnd_guard'),
   ])
   return { ...row, hash }
  } catch (error) {
   const message = String(error)
   if (/UNIQUE constraint failed: hnd_audit\.(sequence|previous_hash)/.test(message)) continue
   if (message.includes('CHECK constraint failed')) throw new Fault('state_changed', 409)
   throw error
  }
 }
 throw new Fault('audit_busy_retry', 409)
}
export async function denied(env: Bindings, actor: Session, action: string, subject = 'installation') {
 await commit(env, actor, action, subject, 'refused', [], false)
}

export const actions = ['case.create','case.correct','case.list','case.read','record.create','record.read','filter.create','product.access','product.request','auth.signin','auth.signout','auth.access','auth.permission','auth.profile','auth.session','audit.read','audit.export','audit.restore','audit.anonymize','audit.modify','grant.create','grant.revoke','grant.read','grant.consent','approval.create','approval.revoke','policy.create','policy.revoke','application.read','application.draft','application.attempt','application.execute']
