import { runtimeBindings, type Bindings } from '../../auth.server'
import { escape as e, Fault, headers, json, text } from '../core'
import { callUrl, readTwilio } from '../consent/store'
import { activeSourceById } from '../providers/sources'
import { verifyCarrierSignature } from '../protection/carrier-proof'
import { xml } from '../protection/twiml'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { finishAttempt } from './dial'
import { holdDecision } from './hold'
import { callbackFence, event, root, type Attempt, type Callback, type Policy } from './model'

const lang = (cb: Callback) => String((JSON.parse(cb.consent) as { language?: string }).language ?? 'en').startsWith('es') ? 'es-MX' : 'en-US'

/** Signed carrier doors for virtual hold and for the callback call itself. Every identity is read back from the provider. */
export async function callbackProviderResponse(request: Request, original: Bindings): Promise<Response | null> {
 const url = new URL(request.url), path = url.pathname
 if (path !== root && !path.startsWith(root + '/')) return null
 const env = runtimeBindings(original)
 try {
  if (url.origin !== env.AUTH_ORIGIN || url.search || request.headers.has('host') && request.headers.get('host')?.toLowerCase() !== url.host.toLowerCase()) throw new Fault('invalid_source_proof', 403)
  if (request.method !== 'POST') throw new Fault('method_not_allowed', 405)
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new Fault('invalid_source_content_type', 415)
  const raw = await request.text()
  if (new TextEncoder().encode(raw).length > 16384) throw new Fault('body_too_large', 413)
  const p = new URLSearchParams(raw)
  await verifyCarrierSignature(request, env, p)
  const hold = path.match(/^\/providers\/twilio\/callbacks\/holds\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/)
  if (hold) return xml(await holdDecision(env, hold[1], hold[2], p))
  const m = path.match(/^\/providers\/twilio\/callbacks\/attempts\/([0-9a-f-]{36})(?:\/(choice|outcome|status))?$/)
  if (!m) throw new Fault('not_found', 404)
  const attempt = await env.DB.prepare('SELECT * FROM hnd_callback_attempts WHERE id=?').bind(m[1]).first<Attempt>()
  if (!attempt) throw new Fault('not_found', 404)
  const cb = (await env.DB.prepare('SELECT * FROM hnd_callbacks WHERE id=?').bind(attempt.callback_id).first<Callback>())!
  const source = await activeSourceById(env, cb.source_id) as (Awaited<ReturnType<typeof activeSourceById>> & { e164: string }) | null
  const policy = await env.DB.prepare('SELECT * FROM hnd_callback_policies WHERE source_id=?').bind(cb.source_id).first<Policy>()
  if (!source || !policy) throw new Fault('callback_authority_unavailable', 409)
  if (p.get('AccountSid') !== source.account_id) throw new Fault('callback_account_mismatch', 403)
  const sid = text(p.get('CallSid'), 'CallSid', 64)
  // The carrier call must be the exact one created for this attempt, from the business number to the consenting caller.
  const call = await readTwilio(env, source, callUrl(source, sid))
  if (call.sid !== sid || call.account_sid !== source.account_id || call.direction !== 'outbound-api' || call.from !== source.e164 || call.to !== cb.recipient) throw new Fault('callback_call_identity_mismatch', 403)
  if (attempt.provider_sid && attempt.provider_sid !== sid) throw new Fault('callback_call_identity_mismatch', 403)
  if (!attempt.provider_sid) await append(env, source.id, 'callback.change', cb.id, 'completed', [callbackFence(env, cb), env.DB.prepare("UPDATE hnd_callback_attempts SET provider_sid=?,state='created' WHERE id=? AND provider_sid IS NULL AND state IN ('claimed','created')").bind(sid, attempt.id), event(env, cb.id, 'attempt_created', { attemptId: attempt.id, callSid: sid, boundAtAnswer: true })], null, sourcePolicy(source))
  const step = m[2] ?? ''
  if (step === 'status') {
   const status = String(call.status)
   if (['no-answer', 'busy', 'failed', 'canceled'].includes(status)) await finishAttempt(env, policy, source, cb, attempt, status, 'signed_status_callback', { status })
   else if (status === 'completed' && ['created', 'answered', 'claimed'].includes(attempt.state)) await finishAttempt(env, policy, source, cb, attempt, 'no_choice', 'customer_hung_up_before_choice', { status })
   return new Response(null, { status: 204, headers })
  }
  if (step === '') {
   await append(env, source.id, 'callback.change', cb.id, 'completed', [callbackFence(env, cb), env.DB.prepare("UPDATE hnd_callback_attempts SET state='answered',reason='Customer answered' WHERE id=? AND state IN ('created','claimed','answered')").bind(attempt.id), event(env, cb.id, 'attempt_answered', { attemptId: attempt.id })], null, sourcePolicy(source))
   const es = lang(cb) === 'es-MX'
   return xml(`<Gather input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="true" action="${e(`${env.AUTH_ORIGIN}${root}/attempts/${attempt.id}/choice`)}" method="POST"><Say language="${lang(cb)}">${e(es ? `${policy.business_name}: usted pidió una llamada. Oprima 1 para hablar ahora, o 2 si ya no la necesita.` : `${policy.business_name}: you asked for a call back. Press 1 to speak with us now, or 2 if you no longer need one.`)}</Say></Gather>`)
  }
  if (step === 'choice') {
   const digit = p.get('Digits')
   if (digit === '1') return xml(`<Dial timeout="20" answerOnBridge="true" action="${e(`${env.AUTH_ORIGIN}${root}/attempts/${attempt.id}/outcome`)}" method="POST"><Number>${e(policy.staff_target)}</Number></Dial>`)
   if (digit === '2') { await finishAttempt(env, policy, source, cb, attempt, 'declined', 'customer_declined_by_keypad', { digits: '2' }); return xml('<Say>No problem. Goodbye.</Say><Hangup/>') }
   await finishAttempt(env, policy, source, cb, attempt, 'no_choice', 'no_valid_key', { digits: digit ?? '' })
   return xml('<Hangup/>')
  }
  // Dial action: the staff leg is read back before anything counts as a conversation.
  const child = await readTwilio(env, source, callUrl(source, text(p.get('DialCallSid'), 'DialCallSid', 64)))
  if (child.sid !== p.get('DialCallSid') || child.account_sid !== source.account_id || child.parent_call_sid !== sid || child.to !== policy.staff_target) throw new Fault('callback_staff_leg_mismatch', 403)
  const duration = Number(child.duration)
  if (child.status === 'completed' && Number.isFinite(duration) && duration >= 1) await finishAttempt(env, policy, source, cb, attempt, 'completed', 'verified_staff_conversation', { childSid: child.sid, duration })
  else await finishAttempt(env, policy, source, cb, attempt, 'staff_unavailable', 'staff_leg_' + String(p.get('DialCallStatus') ?? child.status), { childSid: child.sid, status: child.status })
  return xml('<Hangup/>')
 } catch (error) {
  if (error instanceof Fault) return json({ error: error.code }, error.status)
  if (/UNIQUE constraint|CHECK constraint/.test(String(error))) return json({ error: 'callback_state_changed' }, 409)
  console.error('Handset callback provider failed', error instanceof Error ? error.name : 'unknown')
  return json({ error: 'callback_unavailable' }, 503)
 }
}
