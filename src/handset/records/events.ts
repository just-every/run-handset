import type { RecordRow } from './model'

// One human line per record, in the words a person would use. Unverified transport
// states stay in the line, and a provider-verified record names its source.
export const clock = (at: unknown) => new Date(Number(at)).toISOString().slice(11, 16)
export const dayClock = (at: unknown) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(Number(at))
export const phone = (e164: string) => e164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '$1‑$2‑$3')
export const fields = (r: RecordRow): Record<string, unknown> => { try { return JSON.parse(r.data) } catch { return {} } }
// Who and where a case is about, rather than what happened on it.
export const entityKinds = ['company', 'location', 'number', 'person', 'endpoint', 'flow_version', 'media'] as const

export function eventLine(r: RecordRow): string {
 const d = fields(r), s = (key: string) => String(d[key] ?? ''), state = s('state') || s('providerStatus') || s('status')
 const line = ((): string => {
  switch (r.kind) {
   case 'company': return `Company: ${s('name')}`
   case 'location': return `Location: ${s('name')}`
   case 'number': return `Number ${phone(s('e164'))}${d.purpose ? ' · ' + s('purpose') : ''}`
   case 'person': return `Contact: ${s('name')}`
   case 'endpoint': return `Endpoint: ${s('name')} · ${s('platform')}`
   case 'flow_version': return `Call flow ${s('name')} · revision ${s('revision')}`
   case 'call_session': return ['Call', s('direction'), state].filter(Boolean).join(' · ')
   case 'call_leg': return `Call leg · ${state || 'unknown'}${d.transferFrom ? ' · transferred' : ''}`
   case 'queue_entry': return `Queued · ${state}`
   case 'callback': return `Callback requested · due ${clock(d.dueAt)} · ${state}`
   case 'conversation': return `Conversation: ${s('subject')}`
   case 'message': return `${s('channel') === 'voicemail' ? 'Voicemail' : (s('channel') || 'message').toUpperCase()} ${s('direction')} · ${state || 'unknown'}${d.text ? ': ' + s('text') : ''}`
   case 'media': return `Media: ${s('name')}`
   case 'consent': return `Consent for ${s('purpose')} · ${state}`
   case 'recording': return `Recording: ${s('name')} · ${state || 'unknown'}`
   case 'transcript': return `Transcript (${s('language')}): ${s('text')}`
   case 'disposition': return `Call note: ${s('text')}`
   case 'promise': return `Promised: ${s('text')}`
   case 'provider_attempt': return `Provider attempt: ${s('operation')} · ${state}`
   case 'usage': return `Usage: ${(Number(d.amountCents ?? 0) / 100).toFixed(2)} ${s('currency') || 'USD'}`
   case 'comment': return `Note: ${s('text')}`
  }
 })()
 return r.source === 'native' ? line : `${line} · ${r.source}`
}
