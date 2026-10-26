import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { Fault, id, text } from '../core'
import { callUrl, readTwilio } from '../consent/store'
import { activeSourceById, sourceFence, type Source } from '../providers/sources'
import { callbackFence, event, freeAgents, isStopped, noVoiceStop, policyFence, recipientHold, recoveryEvent, root, type Attempt, type Callback, type Policy } from './model'

type ActiveSource = Source & { e164: string }
const terminal = ['no-answer', 'busy', 'failed', 'canceled']

/** Close one attempt and move its callback: completed and declined are final, anything else stays an owned open task.
 * A busy or unanswered attempt retries in its retained place until the policy limit, then waits for its named owner. */
export async function finishAttempt(env: Bindings, p: Policy, source: ActiveSource, cb: Callback, attempt: Attempt, result: string, reason: string, evidence: unknown, at = Date.now()) {
 if (['completed', 'declined', 'no_choice', ...terminal, 'staff_unavailable'].includes(attempt.state)) return false
 const final = result === 'completed' ? 'completed' : result === 'declined' ? 'declined' : cb.attempts >= p.max_attempts ? 'unanswered' : 'waiting'
 const note = final === 'completed' ? 'Verified conversation with the customer' : final === 'declined' ? 'The customer declined the callback' : final === 'unanswered' ? `Callback attempts exhausted (${result}); the owned task stays open` : `Attempt ${cb.attempts} ended ${result}; retrying in the retained place`
 const recovery = final === 'completed' ? ['resolved', JSON.stringify({ callbackId: cb.id, attemptId: attempt.id, conversation: evidence })] : final === 'declined' ? ['declined', null] : null
 await append(env, source.id, 'callback.change', cb.id, 'completed', [sourceFence(env, source), callbackFence(env, cb),
  env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_callback_attempts WHERE id=? AND state IN (\'claimed\',\'created\',\'answered\',\'uncertain\')').bind(attempt.id),
  env.DB.prepare('UPDATE hnd_callback_attempts SET state=?,reason=?,ended_at=? WHERE id=?').bind(result, reason, at, attempt.id),
  env.DB.prepare('UPDATE hnd_callbacks SET state=?,reason=?,due_at=?,revision=revision+1,updated_at=? WHERE id=?').bind(final, note, final === 'waiting' ? at + p.retry_seconds * 1000 : cb.due_at, at, cb.id),
  ...(recovery ? [env.DB.prepare("UPDATE hnd_recovery SET state=?,resolution=?,reason=?,revision=revision+1,updated_at=? WHERE id=? AND state IN ('open','human','escalated')").bind(recovery[0], recovery[1], note, at, cb.recovery_id), recoveryEvent(env, cb.recovery_id, 'callback_' + final, { callbackId: cb.id, evidence }, source.id, at)] : []),
  event(env, cb.id, 'attempt_' + result, { attemptId: attempt.id, reason, evidence }, at)], null, sourcePolicy(source))
 return true
}
const form = (values: Record<string, string>) => new URLSearchParams(values)

async function place(env: Bindings, p: Policy, source: ActiveSource, cb: Callback, at: number) {
 const n = cb.attempts + 1, attemptId = id(), now = Date.now()
 await append(env, source.id, 'callback.claim', cb.id, 'uncertain', [sourceFence(env, source), policyFence(env, p), callbackFence(env, cb), noVoiceStop(env, cb.recipient, source.number_id),
  env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_recovery WHERE id=? AND state='open'").bind(cb.recovery_id),
  env.DB.prepare("UPDATE hnd_callbacks SET state='dialing',attempts=?,reason='Attempt claimed before any network request; awaiting provider readback',revision=revision+1,updated_at=? WHERE id=?").bind(n, now, cb.id),
  env.DB.prepare("INSERT INTO hnd_callback_attempts VALUES (?,?,?,'claimed',NULL,'claimed before provider create',?,NULL)").bind(attemptId, cb.id, n, now),
  event(env, cb.id, 'attempt_claimed', { attemptId, attemptNo: n, queuedAt: cb.queued_at, priority: cb.priority }, now)], null, sourcePolicy(source))
 const claimed = (await env.DB.prepare('SELECT * FROM hnd_callbacks WHERE id=?').bind(cb.id).first<Callback>())!, attempt = (await env.DB.prepare('SELECT * FROM hnd_callback_attempts WHERE id=?').bind(attemptId).first<Attempt>())!
 let response: Response | null = null
 try {
  response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(source.account_id)}/Calls.json`, {
   method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
   headers: { authorization: 'Basic ' + btoa(source.account_id + ':' + env.HANDSET_TWILIO_AUTH_TOKEN), 'content-type': 'application/x-www-form-urlencoded' },
   body: form({ To: cb.recipient, From: source.e164, Url: `${env.AUTH_ORIGIN}${root}/attempts/${attemptId}`, Method: 'POST', StatusCallback: `${env.AUTH_ORIGIN}${root}/attempts/${attemptId}/status`, StatusCallbackMethod: 'POST', Timeout: '25' }).toString(),
  })
 } catch { response = null }
 if (response && response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408) {
  await finishAttempt(env, p, source, claimed, attempt, 'failed', 'provider_rejected_create', { status: response.status }, Date.now())
  return 'rejected'
 }
 if (!response || response.status !== 201) return markUncertain(env, source, claimed, attempt, 'provider_create_response_lost')
 let sid: string
 try { sid = text((await response.json() as { sid?: string }).sid, 'callSid', 64) } catch { return markUncertain(env, source, claimed, attempt, 'provider_create_response_unreadable') }
 await append(env, source.id, 'callback.change', cb.id, 'completed', [sourceFence(env, source), callbackFence(env, claimed), env.DB.prepare("UPDATE hnd_callback_attempts SET state='created',provider_sid=?,reason='Provider accepted the call; awaiting answer' WHERE id=? AND state='claimed'").bind(sid, attemptId), event(env, cb.id, 'attempt_created', { attemptId, callSid: sid })], null, sourcePolicy(source))
 return 'created'
}
async function markUncertain(env: Bindings, source: ActiveSource, cb: Callback, attempt: Attempt, reason: string) {
 await append(env, source.id, 'callback.change', cb.id, 'uncertain', [sourceFence(env, source), callbackFence(env, cb),
  env.DB.prepare("UPDATE hnd_callback_attempts SET state='uncertain',reason=? WHERE id=? AND state='claimed'").bind(reason, attempt.id),
  env.DB.prepare("UPDATE hnd_callbacks SET state='uncertain',reason=?,revision=revision+1,updated_at=? WHERE id=?").bind('A dial may have started and is never retried automatically: ' + reason, Date.now(), cb.id), event(env, cb.id, 'attempt_uncertain', { attemptId: attempt.id, reason })], null, sourcePolicy(source))
 return 'uncertain'
}
/** After a restart or lost callback, the provider's own Call resource settles every open attempt without a second dial. */
async function reconcile(env: Bindings, at: number) {
 const open = (await env.DB.prepare("SELECT a.*,c.source_id FROM hnd_callback_attempts a JOIN hnd_callbacks c ON c.id=a.callback_id WHERE a.state IN ('claimed','created') ORDER BY a.claimed_at LIMIT 100").all<Attempt & { source_id: string }>()).results
 for (const a of open) {
  const cb = (await env.DB.prepare('SELECT * FROM hnd_callbacks WHERE id=?').bind(a.callback_id).first<Callback>())!, source = await activeSourceById(env, a.source_id) as ActiveSource | null
  if (!source) continue
  if (a.state === 'claimed') { await markUncertain(env, source, cb, a, 'restart_before_provider_answer'); continue }
  if (at - a.claimed_at < 120000) continue
  const p = await env.DB.prepare('SELECT * FROM hnd_callback_policies WHERE source_id=?').bind(a.source_id).first<Policy>()
  let call: Record<string, unknown>
  try { call = await readTwilio(env, source, callUrl(source, a.provider_sid!)) } catch { continue }
  if (call.sid !== a.provider_sid || call.account_sid !== source.account_id || call.direction !== 'outbound-api' || !p) continue
  if (terminal.includes(String(call.status))) await finishAttempt(env, p, source, cb, a, String(call.status), 'provider_readback', { status: call.status }, at)
 }
}
export async function tickCallbacks(env: Bindings, at = Date.now()) {
 await reconcile(env, at)
 const policies = (await env.DB.prepare("SELECT p.* FROM hnd_callback_policies p JOIN oa_operators o ON o.id=p.approved_by WHERE p.enabled=1 AND o.role='owner' AND o.status='active' AND o.version=p.owner_version").all<Policy>()).results
 const placed: string[] = []
 for (const p of policies) {
  const source = await activeSourceById(env, p.source_id) as ActiveSource | null
  if (!source) continue
  let slots = await freeAgents(env, p.queue_id, source.id, at)
  const waiting = (await env.DB.prepare("SELECT c.* FROM hnd_callbacks c JOIN hnd_recovery r ON r.id=c.recovery_id WHERE c.source_id=? AND c.state='waiting' AND c.due_at<=? AND r.state='open' ORDER BY c.priority DESC,c.queued_at,c.id LIMIT 50").bind(source.id, at).all<Callback>()).results
  for (const cb of waiting) {
   if (await isStopped(env, cb.recipient, source.number_id)) {
    await append(env, source.id, 'callback.change', cb.id, 'refused', [sourceFence(env, source), callbackFence(env, cb), env.DB.prepare("UPDATE hnd_callbacks SET state='cancelled',reason='Current opt-out or DNC suppresses contact',revision=revision+1,updated_at=? WHERE id=?").bind(at, cb.id), env.DB.prepare("UPDATE hnd_recovery SET state='stopped',reason='Current opt-out or DNC suppresses contact',revision=revision+1,updated_at=? WHERE id=? AND state='open'").bind(at, cb.recovery_id), event(env, cb.id, 'suppressed', { reason: 'stop_or_dnc' }, at)], null, sourcePolicy(source))
    continue
   }
   const hold = await recipientHold(env, cb.recipient, at)
   if (hold) {
    if (cb.reason !== hold) await append(env, source.id, 'callback.change', cb.id, 'refused', [sourceFence(env, source), callbackFence(env, cb), env.DB.prepare('UPDATE hnd_callbacks SET reason=?,revision=revision+1,updated_at=? WHERE id=?').bind(hold, at, cb.id), event(env, cb.id, 'held', { reason: hold }, at)], null, sourcePolicy(source))
    continue
   }
   if (slots <= 0) break
   // One attempt per callback per tick: a replayed tick finds it already claimed.
   try { if (['created', 'uncertain'].includes(await place(env, p, source, cb, at))) placed.push(cb.id); slots-- } catch (error) { if (!(error instanceof Fault && error.code === 'state_changed')) throw error }
  }
 }
 return { placed }
}
