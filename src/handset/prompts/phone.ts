import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { append, commit } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { escape as e, Fault, choice, id, keys, text, type ObjectValue } from '../core'
import { guard, sql } from '../delegation/store'
import { activeSourceById, sourceFence } from '../providers/sources'
import { normalizeAudio } from './audio'
import { attemptsPerStep, pinHash, root, variants, type Language, type Variant } from './model'
import { versionInsert } from './store'

interface Recording { id: string; prompt_id: string; source_id: string; language: Language; variant: Variant; author_id: string; destination: string; pin_hash: string; state: string; call_sid: string | null; attempts: number; expires_at: number }
const say = (body: string) => `<Say>${e(body)}</Say>`

/** An authorized author asks for a recording callback. The destination must be an active extension that the
 * same person owns, so nobody can have an arbitrary recipient recorded. The server only issues the one-time
 * code and the signed answer door; placing the callback needs a qualified carrier route and stays held. */
export async function requestPhoneRecording(env: Bindings, actor: Session, promptId: string, v: ObjectValue) {
 keys(v, ['sourceId', 'destination', 'language', 'variant'])
 const language = choice(v.language, ['en', 'es'] as const, 'language'), variant = choice(v.variant, variants, 'variant'), destination = text(v.destination, 'destination', 16)
 const source = await activeSourceById(env, text(v.sourceId, 'sourceId', 64))
 if (!source) throw new Fault('source_inactive', 409)
 const own = await sql(env, 'SELECT extension FROM hnd_extensions WHERE operator_id=? AND destination=? AND active=1', actor.operator.id, destination).first()
 if (!own) throw new Fault('unauthorized_record_destination', 403)
 if (!await sql(env, 'SELECT 1 FROM hnd_prompts WHERE id=?', promptId).first()) throw new Fault('prompt_missing', 404)
 const target = id(), pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000), now = Date.now()
 await commit(env, actor, 'prompt.phone', target, 'completed', [sourceFence(env, source),
  guard(env, 'SELECT count(*) FROM hnd_extensions WHERE operator_id=? AND destination=? AND active=1', actor.operator.id, destination),
  sql(env, "INSERT INTO hnd_prompt_recordings(id,prompt_id,source_id,language,variant,author_id,destination,pin_hash,state,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,'awaiting_call',?,?)", target, promptId, source.id, language, variant, actor.operator.id, destination, await pinHash(env, target, pin), now + 900000, now)])
 return { id: target, pin, providerPath: `${root}/recordings/${target}`, destination, placement: 'held: no callback is placed by this server; the carrier route answers the signed door below', expiresAt: now + 900000, note: 'The one-time code is shown once.' }
}
async function load(env: Bindings, key: string, p: URLSearchParams) {
 const rec = await sql(env, 'SELECT * FROM hnd_prompt_recordings WHERE id=?', key).first<Recording>()
 if (!rec) throw new Fault('not_found', 404)
 const source = await activeSourceById(env, rec.source_id)
 if (!source) throw new Fault('source_inactive', 409)
 if (p.get('AccountSid') !== source.account_id || p.get('To') !== rec.destination || p.get('From') !== source.e164) throw new Fault('recording_call_identity_mismatch', 403)
 if (rec.expires_at <= Date.now() || ['recorded', 'refused'].includes(rec.state)) throw new Fault('recording_request_closed', 409)
 const sid = text(p.get('CallSid'), 'CallSid', 64)
 if (rec.call_sid && rec.call_sid !== sid) throw new Fault('recording_call_identity_mismatch', 403)
 return { rec, source, sid }
}
const gather = (key: string, origin: string, prompt: string) => `<Gather input="dtmf" numDigits="6" timeout="8" actionOnEmptyResult="true" action="${e(`${origin}${root}/recordings/${key}/pin`)}" method="POST">${say(prompt)}</Gather>`
export async function phoneRecordingResponse(env: Bindings, key: string, step: string, p: URLSearchParams): Promise<string> {
 const { rec, source, sid } = await load(env, key, p), fences = [sourceFence(env, source)]
 if (step === '') {
  if (!rec.call_sid) await append(env, source.id, 'prompt.phone', rec.id, 'completed', [...fences, sql(env, 'UPDATE hnd_prompt_recordings SET call_sid=? WHERE id=? AND call_sid IS NULL', sid, rec.id)], null, sourcePolicy(source))
  return gather(rec.id, env.AUTH_ORIGIN, 'Enter your six digit recording code.')
 }
 if (step === 'pin') {
  if (!rec.call_sid) throw new Fault('recording_call_not_started', 409)
  const ok = (p.get('Digits') ?? '').length === 6 && await pinHash(env, rec.id, p.get('Digits')!) === rec.pin_hash
  if (ok) {
   await append(env, source.id, 'prompt.phone', rec.id, 'completed', [...fences, guard(env, "SELECT count(*) FROM hnd_prompt_recordings WHERE id=? AND state='awaiting_call' AND call_sid=?", rec.id, sid), sql(env, "UPDATE hnd_prompt_recordings SET state='authenticated',attempts=attempts+1 WHERE id=?", rec.id)], null, sourcePolicy(source))
   return `${say('Record your greeting after the tone. Press pound when you are finished.')}<Record maxLength="60" finishOnKey="#" playBeep="true" action="${e(`${env.AUTH_ORIGIN}${root}/recordings/${rec.id}/recorded`)}" method="POST"/>`
  }
  if (rec.state !== 'awaiting_call') throw new Fault('recording_request_closed', 409)
  const closed = rec.attempts + 1 >= attemptsPerStep
  await append(env, source.id, 'prompt.phone', rec.id, closed ? 'refused' : 'completed', [...fences, sql(env, 'UPDATE hnd_prompt_recordings SET attempts=attempts+1,state=? WHERE id=?', closed ? 'refused' : 'awaiting_call', rec.id)], null, sourcePolicy(source))
  return closed ? say('That code was not accepted. Goodbye.') + '<Hangup/>' : gather(rec.id, env.AUTH_ORIGIN, 'That code was not accepted. Enter your six digit recording code.')
 }
 if (step === 'recorded') {
  if (rec.state !== 'authenticated') throw new Fault('recording_not_authenticated', 409)
  const recordingSid = text(p.get('RecordingSid'), 'RecordingSid', 64), base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(source.account_id)}/Recordings/${encodeURIComponent(recordingSid)}`
  const auth = { authorization: 'Basic ' + btoa(source.account_id + ':' + env.HANDSET_TWILIO_AUTH_TOKEN) }
  let meta: Response, media: Response
  try {
   meta = await fetch(base + '.json', { headers: auth, redirect: 'manual', signal: AbortSignal.timeout(5000) })
   if (meta.status !== 200) throw new Fault('recording_provider_unavailable', 503)
   const info = await meta.json() as { call_sid?: string; account_sid?: string; status?: string }
   if (info.call_sid !== sid || info.account_sid !== source.account_id || info.status !== 'completed') throw new Fault('recording_not_from_this_call', 409)
   media = await fetch(base + '.wav', { headers: auth, redirect: 'manual', signal: AbortSignal.timeout(8000) })
  } catch (error) { throw error instanceof Fault ? error : new Fault('recording_provider_unavailable', 503) }
  if (media.status !== 200) throw new Fault('recording_provider_unavailable', 503)
  const normalized = normalizeAudio(new Uint8Array(await media.arrayBuffer()))
  const { target, statements } = await versionInsert(env, rec.author_id, rec.prompt_id, { source: 'phone_recording', language: rec.language, variant: rec.variant, schedule: {}, audio: normalized.wav, original: normalized.original, durationMs: normalized.durationMs })
  await append(env, source.id, 'prompt.phone', target, 'completed', [...fences, guard(env, "SELECT count(*) FROM hnd_prompt_recordings WHERE id=? AND state='authenticated'", rec.id), ...statements, sql(env, "UPDATE hnd_prompt_recordings SET state='recorded',version_id=? WHERE id=?", target, rec.id)], null, sourcePolicy(source))
  return say('Your greeting was saved as a draft. Goodbye.') + '<Hangup/>'
 }
 throw new Fault('not_found', 404)
}
