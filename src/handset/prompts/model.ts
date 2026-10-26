import type { Bindings } from '../../auth.server'

export type Language = 'en' | 'es'
export type Variant = 'business_hours' | 'holiday' | 'after_hours' | 'always'
export const variants = ['business_hours', 'holiday', 'after_hours', 'always'] as const
export const root = '/providers/twilio/prompts'
/** Documented interdigit timeout: Twilio Gather waits this many seconds for the next digit. */
export const interdigitSeconds = 3
export const attemptsPerStep = 3
const keys: Record<string, string> = { a: '2', b: '2', c: '2', d: '3', e: '3', f: '3', g: '4', h: '4', i: '4', j: '5', k: '5', l: '5', m: '6', n: '6', o: '6', p: '7', q: '7', r: '7', s: '7', t: '8', u: '8', v: '8', w: '9', x: '9', y: '9', z: '9' }
/** Telephone keypad digits for the letters of a name; accents fold to their base letter. */
export const keypad = (name: string) => [...name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()].map(c => keys[c] ?? '').join('')

async function hmac(env: Bindings, message: string) {
 const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.INSTALLATION_KEY ?? ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
 return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))].map(b => b.toString(16).padStart(2, '0')).join('')
}
/** Carrier-fetchable audio needs an unguessable address: only approved versions are ever served. */
export const audioToken = async (env: Bindings, versionId: string) => (await hmac(env, 'prompt-audio:' + versionId)).slice(0, 40)
export const pinHash = (env: Bindings, recordingId: string, pin: string) => hmac(env, `prompt-pin:${recordingId}:${pin}`)
