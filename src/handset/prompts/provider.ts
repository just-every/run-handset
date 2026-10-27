import { runtimeBindings, type Bindings } from '../../auth.server'
import { Fault, headers, json } from '../core'
import { verifyCarrierSignature } from '../protection/carrier-proof'
import { xml } from '../protection/twiml'
import { sql } from '../delegation/store'
import { storedAudio } from './audio'
import { audioToken, root } from './model'
import { phoneRecordingResponse } from './phone'
import { testCallResponse } from './test-calls'
import { activeSourceById, sourceFence } from '../providers/sources'
import { append } from '../audit/store'

/** Signed carrier doors for prompt authoring: audio fetch for Play, the record-by-phone call and the test-call Gather door. */
export async function promptProviderResponse(request: Request, original: Bindings): Promise<Response | null> {
 const url = new URL(request.url), path = url.pathname
 if (path !== root && !path.startsWith(root + '/')) return null
 const env = runtimeBindings(original)
 try {
  if (url.origin !== env.AUTH_ORIGIN || url.search || request.headers.has('host') && request.headers.get('host')?.toLowerCase() !== url.host.toLowerCase()) throw new Fault('invalid_source_proof', 403)
  const audio = path.match(/^\/providers\/twilio\/prompts\/audio\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f]{40})\.wav$/)
  if (audio) {
   if (request.method !== 'GET') throw new Fault('method_not_allowed', 405)
   const test = await sql(env, 'SELECT source_id FROM hnd_prompt_tests WHERE id=? AND call_sid IS NOT NULL AND expires_at>?', audio[1], Date.now()).first<{ source_id: string }>()
   const source = test && await activeSourceById(env, test.source_id)
   const row = await sql(env, "SELECT audio FROM hnd_prompt_versions WHERE id=? AND state='approved'", audio[2]).first<{ audio: string }>()
   if (!source || !row || await audioToken(env, audio[2], audio[1]) !== audio[3]) throw new Fault('not_found', 404)
   const bytes = storedAudio(row.audio)
   await append(env, source.id, 'prompt.play', audio[2], 'completed', [sourceFence(env, source)], null)
   return new Response(bytes, { headers: { ...headers, 'content-type': 'audio/wav', 'content-length': String(bytes.length), 'cache-control': 'private, no-store' } })
  }
  if (request.method !== 'POST') throw new Fault('method_not_allowed', 405)
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new Fault('invalid_source_content_type', 415)
  const raw = await request.text()
  if (new TextEncoder().encode(raw).length > 16384) throw new Fault('body_too_large', 413)
  const p = new URLSearchParams(raw)
  await verifyCarrierSignature(request, env, p)
  const recording = path.match(/^\/providers\/twilio\/prompts\/recordings\/([0-9a-f-]{36})(?:\/(pin|recorded))?$/)
  if (recording) return xml(await phoneRecordingResponse(env, recording[1], recording[2] ?? '', p))
  const test = path.match(/^\/providers\/twilio\/prompts\/tests\/([0-9a-f-]{36})(\/.*)?$/)
  if (test) return xml(await testCallResponse(env, test[1], test[2] ?? '', p))
  throw new Fault('not_found', 404)
 } catch (error) {
  if (error instanceof Fault) return json({ error: error.code }, error.status)
  if (/UNIQUE constraint|CHECK constraint/.test(String(error))) return json({ error: 'prompt_state_changed' }, 409)
  console.error('Handset prompt provider failed', error instanceof Error ? error.name : 'unknown')
  return json({ error: 'prompt_unavailable' }, 503)
 }
}
