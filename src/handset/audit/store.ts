import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { digest, id, ownerFence, Fault } from '../core'
import { policyRevision, type AppliedPolicy } from './policy'

export interface AuditRow {
 sequence: number; id: string; actor: string; action: string; policy: string; subject: string; outcome: string;
 occurred_at: number; previous_hash: string; hash: string; principal?: string | null
}
export const zero = '0'.repeat(64)
export const auditBody = (row: Omit<AuditRow, 'hash'>) => [row.sequence, row.id, row.actor, row.action, row.policy, row.subject, row.outcome, row.occurred_at, row.previous_hash, ...(row.principal ? [row.principal] : [])]
export async function actorRef(db: D1Database, operatorId: string) {
 await db.prepare('INSERT INTO hnd_actor_refs(operator_id,pseudonym) VALUES (?,?) ON CONFLICT DO NOTHING').bind(operatorId, id()).run()
 return (await db.prepare('SELECT pseudonym FROM hnd_actor_refs WHERE operator_id=?').bind(operatorId).first<{pseudonym:string}>())!.pseudonym
}
export async function commit(env: Bindings, actor: Session, action: string, subject: string, outcome: string, statements: D1PreparedStatement[] = [], fence = true, applied:AppliedPolicy = {}) {
 return append(env, await actorRef(env.DB, actor.operator.id), action, subject, outcome, [...(fence ? [ownerFence(env.DB,actor)] : []), ...statements],null,{...applied,native:{role:actor.operator.role,version:actor.operator.version}})
}
export async function append(env: Bindings, pseudonym: string, action: string, subject: string, outcome: string, statements: D1PreparedStatement[] = [], principal: string | null = null, applied:AppliedPolicy = {}) {
 if (principal && !/^[0-9a-f-]{36}$/.test(principal)) throw new Error('Invalid audit principal')
 if (!actions.includes(action) || !['completed','refused','failed','uncertain'].includes(outcome) || !(subject === 'installation' || /^[0-9a-f-]{36}$/.test(subject))) throw new Error('Invalid server audit event')
 const db = env.DB
 for (let retry = 0; retry < 8; retry++) {
  const last = await db.prepare('SELECT sequence,hash FROM hnd_audit ORDER BY sequence DESC LIMIT 1').first<{sequence:number;hash:string}>()
  const row = { sequence: (last?.sequence ?? 0) + 1, id: id(), actor: pseudonym, action, policy:policyRevision(applied), subject, outcome, occurred_at: Date.now(), previous_hash: last?.hash ?? zero, principal }
  const hash = await digest(auditBody(row))
  try {
   await db.batch([
    ...statements,
    db.prepare('INSERT INTO hnd_audit(sequence,id,actor,action,policy,subject,outcome,occurred_at,previous_hash,hash,principal) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(row.sequence, row.id, row.actor, row.action, row.policy, row.subject, row.outcome, row.occurred_at, row.previous_hash, hash, principal),
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

export const actions = ['voicemail.create','voicemail.membership','voicemail.read','voicemail.observe','voicemail.claim','voicemail.handled','voicemail.reopen','directory.read','directory.create','directory.update','directory.merge','directory.grant','directory.revoke','recovery.policy','recovery.intake','exports.request','exports.read','exports.create','exports.approve','exports.transfer','exports.revoke','exports.schedule','exports.deliver','consent.recording','consent.configure','consent.call','consent.identity','consent.capture','consent.enqueue','consent.send','consent.receipt','consent.missed','consent.outcome','consent.verbal','consent.read','consent.recipient','consent.revoke','consent.request','survey.request','survey.create','survey.read','survey.consent','survey.enqueue','survey.deliver','survey.suppress','survey.respond','flow.read','flow.draft','flow.test','flow.publish','flow.rollback','transcript.read','transcript.grant','transcript.revoke','transcript.correct','transcript.annotate','knowledge.request','knowledge.change','knowledge.read','erasure.request','erasure.read','erasure.complete','quality.request','quality.team','quality.grant','quality.revoke','quality.rubric','quality.review','quality.override','quality.comment','quality.read','quality.export','record.usage','compliance.followup','compliance.request','compliance.prepare','compliance.review','compliance.submit','compliance.readback','operations.request','operations.assess','operations.decide','operations.export','delivery.request','automation.preview','automation.publish','automation.pause','automation.event','automation.enqueue','automation.deliver','automation.request','recovery.create','recovery.change','recovery.request','followup.create','followup.change','followup.request','records.request','authority.request','audit.request','source.request','admin.request','queue.request','metrics.request','protection.request','dialer.request','import.request','frontdesk.request','recording.request','delegation.create','delegation.revoke','delegation.read','line.configure','presence.change','frontdesk.approve','frontdesk.route','frontdesk.answer','frontdesk.pickup','frontdesk.park','frontdesk.transfer','frontdesk.callback','recording.grant','recording.revoke','recording.playback','admin.read','admin.preview','admin.approve','admin.apply','admin.override','template.create','template.revise','metrics.read','metrics.configure','metrics.finalize','metrics.schedule','metrics.deliver','protection.read','protection.rule','protection.revoke','protection.configure','protection.admit','protection.contain','protection.alert','source.create','source.revoke','source.read','source.held','source.receive','source.replay','source.refuse','case.create','case.correct','case.list','case.read','record.create','record.read','filter.create','product.access','product.request','auth.signin','auth.signout','auth.access','auth.permission','auth.profile','auth.session','audit.read','audit.export','audit.grant','audit.revoke','scope.grant','scope.revoke','audit.restore','audit.anonymize','audit.modify','grant.create','grant.rotate','grant.revoke','grant.read','grant.consent','approval.create','approval.revoke','policy.create','policy.revoke','application.read','application.draft','application.attempt','application.execute','receptionist.request','outcome.policy','outcome.open','outcome.read','outcome.step','outcome.authorize','outcome.escalate','outcome.decide','prompt.read','prompt.create','prompt.preview','prompt.approve','prompt.phone','prompt.test','extension.write','callback.policy','callback.create','callback.hold','callback.claim','callback.change']
