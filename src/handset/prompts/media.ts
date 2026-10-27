import { Fault } from '../core'
import { maxUploadBytes } from './audio'

/** Bound decoded provider bytes even when Content-Length is absent or false. */
export async function audioResponse(response: Response): Promise<Uint8Array> {
 if (response.status !== 200 || !['audio/wav', 'audio/x-wav', 'audio/wave'].includes((response.headers.get('content-type') ?? '').split(';')[0].toLowerCase())) throw new Fault('invalid_provider_audio', 502)
 const declared = response.headers.get('content-length')
 if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxUploadBytes)) throw new Fault('invalid_provider_audio', 502)
 if (!response.body) throw new Fault('invalid_provider_audio', 502)
 const reader = response.body.getReader(), chunks: Uint8Array[] = []
 let size = 0
 try {
  for (;;) {
   const { value, done } = await reader.read()
   if (done) break
   size += value.length
   if (size > maxUploadBytes) throw new Fault('invalid_provider_audio', 502)
   chunks.push(value)
  }
 } finally { await reader.cancel() }
 if (declared !== null && Number(declared) !== size) throw new Fault('invalid_provider_audio', 502)
 const bytes = new Uint8Array(size)
 let at = 0
 for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
 return bytes
}
