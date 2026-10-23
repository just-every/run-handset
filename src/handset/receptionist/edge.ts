import { Fault } from '../core'

/** A receiving system's answer to one effect attempt. `uncertain` means the effect may
 * have committed: the response was lost, late or malformed. Only readback or an explicit
 * human resolution settles it. */
export interface EdgeResult { state: 'confirmed' | 'rejected' | 'uncertain' | 'held'; externalId?: string; readback?: unknown; reason: string }
export const held = (reason: string): EdgeResult => ({ state: 'held', reason })
export const uncertain = (reason: string): EdgeResult => ({ state: 'uncertain', reason })
export const rejected = (reason: string): EdgeResult => ({ state: 'rejected', reason })
export interface Wire { status: number; body: Record<string, unknown> }
/** Origins come from installation bindings; a credential never leaves its own origin. */
export function origin(value: string | undefined, name: string) {
 if (!value) return null
 let url: URL
 try { url = new URL(value) } catch { throw new Fault(`invalid_${name}`, 500) }
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Fault(`invalid_${name}`, 500)
 return url.origin
}
/** Returns null when the transport lost the answer; definitive HTTP answers always parse as objects. */
export async function send(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Wire | null> {
 try {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(8000) })
  if (response.status >= 500 || response.status === 408) return null
  const raw = await response.text()
  let body: unknown
  try { body = raw ? JSON.parse(raw) : {} } catch { return response.status >= 400 ? { status: response.status, body: {} } : null }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return response.status >= 400 ? { status: response.status, body: {} } : null
  return { status: response.status, body: body as Record<string, unknown> }
 } catch { return null }
}
export const bearer = (token: string | undefined) => ({ authorization: 'Bearer ' + token })
export const instant = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : NaN
