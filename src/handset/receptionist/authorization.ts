import type { Bindings } from '../../auth.server'
import { runtimeBindings } from '../../auth.server'
import { digest, escape, Fault, id } from '../core'
import { append } from '../audit/store'
import { verifyCarrierSignature } from '../protection/carrier-proof'
import { xml } from '../protection/twiml'
import { dollars, type Authorization, type Language, type Outcome } from './model'

const ttl = 600000, voices: Record<Language, string> = { en: 'en-US', es: 'es-US' }
/** The caller hears exact USD amount, payee and purpose, then presses 1. This text is generated here,
 * never by the agent, and the answer arrives only through the carrier's signed callback. */
export const promptFor = (language: Language, payee: string, amountCents: number, purpose: string) => language === 'es'
 ? `${payee} solicita un depósito de ${dollars(amountCents)} para ${purpose}. Presione 1 para autorizar exactamente este cargo, o 2 para rechazarlo.`
 : `${payee} is asking for a ${dollars(amountCents)} deposit for ${purpose}. Press 1 to authorize exactly this charge, or 2 to decline.`
export const authorizationHash = (a: Pick<Authorization, 'outcome_id' | 'amount_cents' | 'payee' | 'purpose' | 'language' | 'prompt'>) => digest([a.outcome_id, a.amount_cents, a.payee, a.purpose, a.language, a.prompt])
export const authorizationRow = (db: D1Database, authorizationId: string) => db.prepare('SELECT * FROM hnd_rx_authorizations WHERE id=?').bind(authorizationId).first<Authorization>()
export async function proposeAuthorization(env: Bindings, grantFence: D1PreparedStatement, grantId: string, applied: Parameters<typeof append>[7], outcome: Outcome, payee: string, amountCents: number, purpose: string) {
 const existing = await env.DB.prepare("SELECT * FROM hnd_rx_authorizations WHERE outcome_id=? AND amount_cents=? AND purpose=? AND state='proposed' AND expires_at>? ORDER BY created_at DESC LIMIT 1").bind(outcome.id, amountCents, purpose, Date.now()).first<Authorization>()
 if (existing) return existing
 const authorizationId = id(), prompt = promptFor(outcome.language, payee, amountCents, purpose), now = Date.now()
 const row = { outcome_id: outcome.id, amount_cents: amountCents, payee, purpose, language: outcome.language, prompt }
 await append(env, grantId, 'outcome.authorize', authorizationId, 'uncertain', [grantFence,
  env.DB.prepare("INSERT INTO hnd_rx_authorizations(id,outcome_id,amount_cents,payee,purpose,language,prompt,prompt_hash,state,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,'proposed',?,?)").bind(authorizationId, outcome.id, amountCents, payee, purpose, outcome.language, prompt, await authorizationHash(row), now, now + ttl),
 ], null, applied)
 return (await authorizationRow(env.DB, authorizationId))!
}
const base = '/providers/twilio/receptionist/'
export const promptUrl = (env: Bindings, authorizationId: string) => `${env.AUTH_ORIGIN}${base}${authorizationId}/prompt`
const say = (a: Authorization, text: string) => `<Say language="${voices[a.language]}">${escape(text)}</Say>`
function gather(env: Bindings, a: Authorization) {
 return `<Gather input="dtmf" numDigits="1" timeout="10" method="POST" action="${escape(`${env.AUTH_ORIGIN}${base}${a.id}/confirm`)}">${say(a, a.prompt)}</Gather>${say(a, a.language === 'es' ? 'No se cobró nada.' : 'Nothing was charged.')}`
}
/** Carrier callbacks: the fetched TwiML prompt and the signed DTMF answer. Only the holder of the carrier
 * secret can produce them, so neither the agent nor the caller's words can authorize a charge. */
export async function receptionistProviderResponse(request: Request, original: Bindings): Promise<Response | null> {
 const url = new URL(request.url), match = url.pathname.match(/^\/providers\/twilio\/receptionist\/([0-9a-f-]{36})\/(prompt|confirm)$/)
 if (!url.pathname.startsWith(base)) return null
 const env = runtimeBindings(original)
 try {
  if (!match) throw new Fault('not_found', 404)
  if (url.origin !== env.AUTH_ORIGIN || url.search || request.headers.has('host') && request.headers.get('host')?.toLowerCase() !== url.host.toLowerCase()) throw new Fault('invalid_source_proof', 403)
  if (request.method !== 'POST') throw new Fault('method_not_allowed', 405)
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new Fault('invalid_source_content_type', 415)
  const raw = await request.text()
  if (new TextEncoder().encode(raw).length > 16384) throw new Fault('body_too_large', 413)
  const p = new URLSearchParams(raw)
  await verifyCarrierSignature(request, env, p)
  const a = await authorizationRow(env.DB, match[1])
  const outcome = a ? await env.DB.prepare('SELECT * FROM hnd_rx_outcomes WHERE id=?').bind(a.outcome_id).first<Outcome>() : null
  if (!a || !outcome || p.get('CallSid') !== outcome.call_id || p.get('CallStatus') !== 'in-progress') throw new Fault('invalid_source_proof', 403)
  if (a.state !== 'proposed' || a.expires_at <= Date.now() || a.prompt_hash !== await authorizationHash(a)) return xml(say(a, a.language === 'es' ? 'Esta autorización ya no es válida. No se cobró nada.' : 'This authorization is no longer valid. Nothing was charged.'), 'authorization_not_open')
  if (match[2] === 'prompt') return xml(gather(env, a))
  const digits = p.get('Digits')
  if (digits !== '1' && digits !== '2') return xml(gather(env, a), 'digit_not_recognised')
  const state = digits === '1' ? 'authorized' : 'declined'
  await append(env, outcome.grant_id, 'outcome.authorize', a.id, state === 'authorized' ? 'completed' : 'refused', [
   env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rx_authorizations WHERE id=? AND state=? AND expires_at>?').bind(a.id, 'proposed', Date.now()),
   env.DB.prepare("UPDATE hnd_rx_authorizations SET state=?,evidence=?,decided_at=? WHERE id=? AND state='proposed'").bind(state, JSON.stringify({ channel: 'dtmf', callSid: outcome.call_id, digit: digits, signedBy: 'carrier' }), Date.now(), a.id),
  ])
  return xml(say(a, state === 'authorized' ? (a.language === 'es' ? 'Gracias. Autorizó este cargo.' : 'Thank you. You authorized this charge.') : (a.language === 'es' ? 'Entendido. No se cobrará nada.' : 'Understood. Nothing will be charged.')))
 } catch (error) {
  if (error instanceof Fault) { const refused = xml('<Say>Request refused.</Say>', error.code); return new Response(refused.body, { status: error.status, headers: refused.headers }) }
  console.error('Handset receptionist callback failed', error instanceof Error ? error.name : 'unknown')
  return new Response('Temporarily unavailable', { status: 503 })
 }
}
