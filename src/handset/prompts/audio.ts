import { Fault } from '../core'

/** Qualified carrier format: 8 kHz, mono, 8-bit mu-law in a WAV container (Twilio Play accepts it directly). */
export const carrierFormat = 'wav-mulaw-8000-mono'
export const maxUploadBytes = 3 * 1024 * 1024
const minMs = 300, maxMs = 120000

export interface Normalized { wav: Uint8Array; durationMs: number; original: string }

const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
function mulaw(sample: number) {
 const bias = 0x84, clip = 32635
 const sign = sample < 0 ? 0x80 : 0
 let value = Math.min(Math.abs(sample), clip) + bias
 let exponent = 7
 for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent--
 return ~(sign | exponent << 4 | value >> exponent + 3 & 0x0f) & 0xff
}
function mulawDecode(byte: number) {
 const v = ~byte & 0xff, exponent = v >> 4 & 7, mantissa = v & 15
 const sample = (mantissa << 3 | 0x84) << exponent
 return (v & 0x80 ? 0x84 - sample : sample - 0x84)
}
function header(bytes: number) {
 const out = new Uint8Array(58), view = new DataView(out.buffer), put = (at: number, text: string) => [...text].forEach((c, i) => { out[at + i] = c.charCodeAt(0) })
 put(0, 'RIFF'); view.setUint32(4, 50 + bytes, true); put(8, 'WAVE'); put(12, 'fmt ')
 view.setUint32(16, 18, true); view.setUint16(20, 7, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true)
 view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true); view.setUint16(36, 0, true)
 put(38, 'fact'); view.setUint32(42, 4, true); view.setUint32(46, bytes, true); put(50, 'data'); view.setUint32(54, bytes, true)
 return out
}
/** Parses a PCM16 or mu-law WAV file and returns the normalized carrier WAV. Anything else is refused. */
export function normalizeAudio(input: Uint8Array): Normalized {
 if (input.length < 44 || input.length > maxUploadBytes) throw new Fault('invalid_audio_file', 422)
 if (tag(input, 0) !== 'RIFF' || tag(input, 8) !== 'WAVE') throw new Fault('unsupported_audio_format', 422)
 const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
 if (view.getUint32(4, true) !== input.length - 8) throw new Fault('invalid_audio_file', 422)
 let at = 12, format = 0, channels = 0, rate = 0, bits = 0, block = 0, bytesPerSecond = 0, data: Uint8Array | null = null
 while (at + 8 <= input.length) {
  const name = tag(input, at), size = view.getUint32(at + 4, true), body = at + 8
  if (body + size > input.length) throw new Fault('invalid_audio_file', 422)
  if (name === 'fmt ') {
   if (size < 16 || format) throw new Fault('invalid_audio_file', 422)
   format = view.getUint16(body, true); channels = view.getUint16(body + 2, true); rate = view.getUint32(body + 4, true); bits = view.getUint16(body + 14, true)
   bytesPerSecond = view.getUint32(body + 8, true); block = view.getUint16(body + 12, true)
  } else if (name === 'data') {
   if (data) throw new Fault('invalid_audio_file', 422)
   data = input.subarray(body, body + size)
  }
  at = body + size + (size & 1)
 }
 if (at !== input.length && at !== input.length + 1) throw new Fault('invalid_audio_file', 422)
 const pcm = format === 1 && bits === 16, law = format === 7 && bits === 8
 if (!data || !(pcm || law) || channels < 1 || channels > 2 || rate < 8000 || rate > 48000) throw new Fault('unsupported_audio_format', 422)
 const frame = (pcm ? 2 : 1) * channels, frames = Math.floor(data.length / frame)
 if (!frames || data.length % frame || block !== frame || bytesPerSecond !== rate * frame) throw new Fault('invalid_audio_file', 422)
 const sampleAt = (index: number) => {
  let sum = 0
  for (let c = 0; c < channels; c++) {
   const offset = index * frame + c * (pcm ? 2 : 1)
   sum += pcm ? new DataView(data!.buffer, data!.byteOffset + offset, 2).getInt16(0, true) : mulawDecode(data![offset])
  }
  return sum / channels
 }
 const durationMs = Math.round(frames / rate * 1000)
 if (durationMs < minMs || durationMs > maxMs) throw new Fault('audio_duration_out_of_range', 422)
 const count = Math.floor(frames * 8000 / rate), out = new Uint8Array(count)
 for (let i = 0; i < count; i++) {
  // Box-filter every source frame that falls into this 8 kHz sample.
  const from = Math.floor(i * rate / 8000), to = Math.max(from + 1, Math.floor((i + 1) * rate / 8000))
  let sum = 0
  for (let j = from; j < to && j < frames; j++) sum += sampleAt(j)
  out[i] = mulaw(Math.round(sum / (Math.min(to, frames) - from)))
 }
 const wav = new Uint8Array(58 + count)
 wav.set(header(count)); wav.set(out, 58)
 return { wav, durationMs, original: `${pcm ? 'pcm16' : 'mulaw'}-${rate}-${channels}ch` }
}
export const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map(b => b.toString(16).padStart(2, '0')).join('')
export function fromBase64(value: unknown): Uint8Array {
 if (typeof value !== 'string' || !value || value.length > Math.ceil(maxUploadBytes * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Fault('invalid_audio_file', 422)
 try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)) } catch { throw new Fault('invalid_audio_file', 422) }
}
export function toBase64(bytes: Uint8Array) {
 let out = ''
 for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192))
 return btoa(out)
}
export const storedAudio = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0))
