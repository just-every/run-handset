import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault } from '../core'
import { recordsDoor } from '../records/doors'
import { entityKinds, eventLine, fields, phone } from '../records/events'
import type { RecordRow } from '../records/model'
import type { CaseRow } from '../records/store'

export type CaseDetail = { current: CaseRow; history: unknown[]; records: RecordRow[] }

/** Reads each case through the records door, so every case shown is authorized and audited as a case read. */
export async function caseDetails(request: Request, env: Bindings, actor: Session, ids: string[]) {
 const headers = new Headers(['cookie', 'host'].flatMap(name => request.headers.has(name) ? [[name, request.headers.get(name)!]] : [])), found = new Map<string, CaseDetail>()
 for (const caseId of [...new Set(ids)]) {
  try {
   const response = await recordsDoor(new Request(new URL('/api/handset/cases/' + encodeURIComponent(caseId), request.url), { headers }), env, actor)
   if (response?.ok) found.set(caseId, await response.json() as CaseDetail)
  } catch (error) { if (!(error instanceof Fault) || error.status >= 500) throw error }
 }
 return found
}

const latest = (detail: CaseDetail | undefined, kind: string) => detail?.records.filter(r => r.kind === kind && !detail.records.some(n => n.supersedes_id === r.id)).at(-1)

/** Who the follow-up is with: the case's contact, else its number, else the case itself. */
export function caller(detail: CaseDetail | undefined, caseId: string) {
 const person = latest(detail, 'person'), number = latest(detail, 'number'), callback = latest(detail, 'callback'), topic = latest(detail, 'conversation')
 const e164 = number ? String(fields(number).e164 ?? '') : ''
 const name = person ? String(fields(person).name ?? '') : e164 ? phone(e164) : detail?.current.title ?? 'Case ' + caseId.slice(0, 8)
 const line = number ? String(fields(number).purpose ?? '') : ''
 const reason = callback && fields(callback).state === 'pending' ? 'Callback requested' : topic ? String(fields(topic).subject ?? '') : name === detail?.current.title ? '' : detail?.current.title ?? ''
 return { name, number: person && e164 ? phone(e164) : '', line, reason, title: detail?.current.title ?? '' }
}

/** The case's most recent events, oldest first; who and where stay in the contact line. */
export const recent = (detail: CaseDetail | undefined, count = 4) => (detail?.records ?? []).filter(r => !(entityKinds as readonly string[]).includes(r.kind)).slice(-count).map(r => ({ at: r.occurred_at, text: eventLine(r) }))

/** The records a follow-up may cite: current promises, transcripts and call notes. */
export const citable = (detail: CaseDetail | undefined) => (detail?.records ?? []).filter(r => ['promise', 'transcript', 'disposition'].includes(r.kind) && !detail!.records.some(n => n.supersedes_id === r.id))
