import type { Bindings } from '../../auth.server'
import { aiConfig } from '../../modules/ai/index.mjs'
import { Fault } from '../core'
import { audioResponse } from './media'

const model = 'gpt-4o-mini-tts'
const voices = { en: 'alloy', es: 'alloy' } as const
const styles = { en: 'Speak clearly and warmly in American English, as a business greeting.', es: 'Habla con claridad y calidez en español latinoamericano, como un saludo de negocio.' } as const

/** Official OpenAI speech schema (POST audio speech: model, input, voice, instructions, response_format).
 * Only the direct transport carries this operation; the shared models service does not. */
export async function synthesize(env: Bindings, language: 'en' | 'es', script: string): Promise<Uint8Array> {
 const selected = aiConfig({ ...env }).direct
 let origin: URL
 try { origin = new URL(selected?.baseUrl ?? '') } catch { throw new Fault('tts_unavailable', 503) }
 if (!aiConfig({ ...env }).enabled || !selected?.apiKey || /\s/.test(selected.apiKey) || origin.protocol !== 'https:' || origin.username || origin.search || origin.hash) throw new Fault('tts_unavailable', 503)
 let response: Response
 try {
  response = await fetch(origin.href.replace(/\/+$/, '') + '/audio/speech', {
   method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
   headers: { authorization: 'Bearer ' + selected.apiKey, 'content-type': 'application/json', accept: 'audio/wav' },
   body: JSON.stringify({ model, input: script, voice: voices[language], instructions: styles[language], response_format: 'wav' }),
  })
 } catch { throw new Fault('tts_unavailable', 503) }
 if (response.status !== 200 || !(response.headers.get('content-type') ?? '').startsWith('audio/')) throw new Fault('tts_unavailable', 502)
 return audioResponse(response)
}
