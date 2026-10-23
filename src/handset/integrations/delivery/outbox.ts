import type { Bindings } from '../../../auth.server'
import { operatorMail } from '../../../mail.server.mjs'
import { actorRef, append } from '../../audit/store'
import { escape, Fault, id } from '../../core'
import type { Rule, RuleDefinition } from '../../automation/rules'
import { eventRecord } from '../../automation/rules'

interface Run { id: string; rule_id: string; rule_revision: number; record_id: string; case_id: string; case_version: number; owner_id: string; owner_version: number; action: string; state: string; due_at: number; next_due_at: number; reason: string; created_at: number; updated_at: number }
const ownerGuard = (env: Bindings, ownerId: string, version: number) => env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND role='owner' AND status='active'").bind(ownerId, version)
const ruleGuard = (env: Bindings, rule: Rule) => env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rules WHERE id=? AND revision=? AND state='active'").bind(rule.id, rule.revision)
const runGuard = (env: Bindings, run: Run) => env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rule_runs WHERE id=? AND state='queued'").bind(run.id)
export async function tickRules(env: Bindings, at = Date.now()) {
 // A process that died after claiming an effect cannot be retried. Keep it uncertain.
 await env.DB.prepare("UPDATE hnd_rule_runs SET state='uncertain',reason='Interrupted after effect claim; readback or human repair required' WHERE state='sending' AND updated_at<?").bind(at - 60000).run()
 // Rule output is never an eligible input event. Native callbacks become due once.
 await env.DB.prepare("INSERT INTO hnd_rule_events SELECT id,'callback_due',? FROM hnd_records WHERE kind='callback' AND json_extract(data,'$.dueAt')<=? AND case_id IS NOT NULL ON CONFLICT(record_id) DO NOTHING").bind(at, at).run()
 const rules = (await env.DB.prepare("SELECT * FROM hnd_rules WHERE state='active' ORDER BY created_at LIMIT 100").all<Rule>()).results
 for (const rule of rules) {
  const d = JSON.parse(rule.definition) as RuleDefinition
  const events = (await env.DB.prepare('SELECT e.record_id,r.case_id,c.version FROM hnd_rule_events e JOIN hnd_records r ON r.id=e.record_id JOIN hnd_cases c ON c.id=r.case_id WHERE e.trigger=? AND e.created_at>=? AND NOT EXISTS(SELECT 1 FROM hnd_rule_runs j WHERE j.record_id=e.record_id AND (j.rule_id=? OR (j.action=? AND j.owner_id=?))) ORDER BY e.created_at LIMIT 100').bind(d.trigger, rule.created_at, rule.id, d.action, rule.owner_id).all<{record_id: string; case_id: string; version: number}>()).results
  for (const event of events) {
   try {
    await eventRecord(env, event.record_id, d.trigger, at)
    const key = id(), due = at + d.delayMinutes * 60000
    await append(env, await actorRef(env.DB, rule.owner_id), 'automation.enqueue', key, 'completed', [ownerGuard(env, rule.owner_id, rule.owner_version), ruleGuard(env, rule),
     env.DB.prepare("INSERT INTO hnd_rule_runs(id,rule_id,rule_revision,record_id,case_id,case_version,owner_id,owner_version,action,state,due_at,next_due_at,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?,'',?,?)").bind(key, rule.id, rule.revision, event.record_id, event.case_id, event.version, rule.owner_id, rule.owner_version, d.action, due, due, at, at),
    ])
   } catch (error) { if (!(error instanceof Fault) && !String(error).includes('UNIQUE constraint failed: hnd_rule_runs')) throw error }
  }
 }
 const runs = (await env.DB.prepare("SELECT * FROM hnd_rule_runs WHERE state='queued' AND next_due_at<=? ORDER BY due_at,id LIMIT 100").bind(at).all<Run>()).results
 const results: {id: string; state: string; reason: string}[] = []
 for (const run of runs) {
  const rule = await env.DB.prepare('SELECT * FROM hnd_rules WHERE id=?').bind(run.rule_id).first<Rule>(), actor = await actorRef(env.DB, run.owner_id)
  const finish = async (state: string, reason: string, expected = 'queued') => {
   try { await append(env, actor, 'automation.deliver', run.id, state === 'uncertain' ? 'uncertain' : state === 'failed' ? 'failed' : 'completed', [env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rule_runs WHERE id=? AND state=?').bind(run.id, expected), env.DB.prepare('UPDATE hnd_rule_runs SET state=?,reason=?,updated_at=? WHERE id=?').bind(state, reason, at, run.id)]) } catch (error) { if (error instanceof Fault && error.code === 'state_changed') return; throw error }
   results.push({ id: run.id, state, reason })
  }
  const owner = await env.DB.prepare("SELECT email FROM oa_operators WHERE id=? AND version=? AND role='owner' AND status='active'").bind(run.owner_id, run.owner_version).first<{email: string}>()
  if (!owner || !rule || rule.state !== 'active' || rule.revision !== run.rule_revision || rule.owner_id !== run.owner_id || rule.owner_version !== run.owner_version) { await finish('canceled', 'Rule version, publication or owner authority changed'); continue }
  const d = JSON.parse(rule.definition) as RuleDefinition
  try { await eventRecord(env, run.record_id, d.trigger, at) } catch { await finish('canceled', 'Source event changed or was superseded'); continue }
  const currentCase = await env.DB.prepare('SELECT version FROM hnd_cases WHERE id=?').bind(run.case_id).first<{version: number}>()
  if (currentCase?.version !== run.case_version) { await finish('canceled', 'Human case edit invalidated the queued rule'); continue }
  const stopQuery = `SELECT count(*) AS n FROM hnd_protection_stops s JOIN hnd_records r ON r.case_id=? WHERE s.recipient IN (json_extract(r.data,'$.from'),json_extract(r.data,'$.to'))`
  const stopped = await env.DB.prepare(stopQuery).bind(run.case_id).first<{n: number}>()
  if (stopped?.n) { await finish('canceled', 'Current STOP or DNC canceled pending follow-up'); continue }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: d.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at), minute = Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value)
  if (minute < d.startMinute || minute >= d.endMinute) {
   await append(env, actor, 'automation.deliver', run.id, 'refused', [runGuard(env, run), env.DB.prepare("UPDATE hnd_rule_runs SET reason='Owner notice quiet hours; still open',next_due_at=?,updated_at=? WHERE id=?").bind(at + 15 * 60000, at, run.id)])
   continue
  }
  if (!['internal','owner_email'].includes(d.action)) { await finish('held', d.action + '_adapter_unqualified; no customer contact'); continue }
  if (d.action === 'owner_email' && owner.email !== env.OWNER_EMAIL) { await finish('canceled', 'Installation owner mailbox changed'); continue }
  try {
   await append(env, actor, 'automation.deliver', run.id, 'uncertain', [runGuard(env, run), ownerGuard(env, run.owner_id, run.owner_version), ruleGuard(env, rule),
    env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT CASE WHEN count(*)<100 THEN 1 ELSE 0 END FROM hnd_rule_runs WHERE rule_id=? AND state IN ('sending','accepted','uncertain')").bind(run.rule_id),
    env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_cases WHERE id=? AND version=?').bind(run.case_id, run.case_version),
    env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_records WHERE supersedes_id=?) THEN 0 ELSE 1 END').bind(run.record_id),
    env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT CASE WHEN (${stopQuery})=0 THEN 1 ELSE 0 END`).bind(run.case_id),
    env.DB.prepare("UPDATE hnd_rule_runs SET state='sending',reason='Effect claimed; lost response requires readback or human repair',updated_at=? WHERE id=?").bind(at, run.id),
   ])
  } catch (error) { if (error instanceof Fault && error.code === 'state_changed') continue; throw error }
  if (d.action === 'internal') { await finish('owned', 'Internal next step recorded; promised work remains open', 'sending'); continue }
  let state = 'uncertain', reason = 'Mail response lost; do not resend without readback or human repair'
  try {
   const sender = operatorMail(env)
   if (!sender || !env.MAIL_FROM) { state = 'failed'; reason = 'Authorized mail transport unavailable' }
   else {
    const body = `${d.message}\nHandset case: ${run.case_id}\nSource: ${run.record_id}\nRun: ${run.id}\nOwner: ${run.owner_id}\nNext due: ${new Date(run.next_due_at).toISOString()}\nA sent reminder does not complete this work.`
    const receipt = await sender.send({ deliveryId: run.id, from: env.MAIL_FROM, to: [owner.email], subject: 'Handset follow-up: ' + d.name, text: body, html: `<pre>${escape(body)}</pre>`, headers: {} })
    state = receipt.status === 'accepted' ? 'accepted' : receipt.status === 'development' ? 'held' : receipt.status === 'uncertain' ? 'uncertain' : 'failed'
    reason = state === 'accepted' ? 'Provider accepted owner notice; inbox receipt and promised work remain unconfirmed' : state === 'held' ? 'Development mail suppressed' : state === 'failed' ? 'Mail provider refused notice' : reason
   }
  } catch { /* Keep uncertainty and never replay a started mail effect. */ }
  await finish(state, reason, 'sending')
 }
 return { results, customerSends: 0 }
}
