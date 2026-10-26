import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { consolePage, escape as e, field, hidden, Fault, keys, type ObjectValue } from '../core'
import { denied } from '../audit/store'
import { rulesPage } from './pages'
import { followupsPage } from '../followups/pages'
import { recoveryPage } from '../recovery/pages'
import { operationsPage } from '../operations/pages'
import { callbackSettingsPage, callbacksPage } from '../callbacks/pages'

export type Row = Record<string, string | number | null>
export type Snapshot = Record<string, unknown>
export const when = (at: unknown) => new Date(Number(at)).toISOString()
export const details = (pairs: [string, unknown][]) => `<dl>${pairs.map(([label, value]) => `<dt>${e(label)}</dt><dd>${e(value)}</dd>`).join('')}</dl>`
export const form = (path: string, label: string, body = '') => `<form method="post" action="${e(path)}">${body}<button>${e(label)}</button></form>`
export const note = () => field('Evidence note', 'note')
export const due = (at = Date.now() + 3600000) => field('Due at (UTC)', 'dueAt', new Date(at).toISOString().slice(0, 16), 'datetime-local')
export const revision = (row: Row) => hidden('revision', row.revision)
export const approval = (value: string, label: string) => `<label><input type="checkbox" name="confirm" value="${e(value)}" required> ${e(label)}</label>`
export const area = (label: string, name: string, value = '') => `<label>${e(label)}<textarea aria-label="${e(label)}" name="${e(name)}" rows="4" required>${e(value)}</textarea></label>`
export const bounds = (text: string) => `<p role="status">${e(text)}</p>`

type Door = (request: Request, env: Bindings, actor: Session, value?: ObjectValue) => Promise<Response | null>
const pages: Record<string, (snapshot: Snapshot, url: URL, request: Request, env: Bindings, actor: Session) => Promise<Response>> = { rules: rulesPage, followups: followupsPage, recovery: recoveryPage, callbacks: callbacksPage, operations: operationsPage }
function formValue(root: string, suffix: string, raw: ObjectValue): ObjectValue {
 const value = { ...raw }
 for (const key of ['revision', 'expectedRevision', 'delayMinutes', 'startMinute', 'endMinute', 'maxAttempts', 'retrySeconds']) if (key in value) value[key] = Number(value[key])
 if ('dueAt' in value) {
  if (typeof value.dueAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value.dueAt)) throw new Fault('invalid_dueAt')
  value.dueAt = Date.parse(value.dueAt + ':00Z')
 }
 if (root === 'rules' && suffix === '/preview') {
  keys(value, ['name','trigger','action','message','delayMinutes','timezone','startMinute','endMinute','sampleRecordId','ruleId','expectedRevision'])
  const { sampleRecordId, ruleId, expectedRevision, ...definition } = value
  return { definition, sampleRecordId, ...(ruleId ? { ruleId, expectedRevision } : {}) }
 }
 if (value.queueEntryId === '') delete value.queueEntryId
 return value
}
/** HTML forms reuse the native API implementation and its exact revision and authority fences. */
export async function workConsole(request: Request, env: Bindings, actor: Session, root: string, door: Door, raw?: ObjectValue): Promise<Response | null> {
 const render = pages[root], url = new URL(request.url), base = '/app/' + root
 if (!render || (url.pathname !== base && !url.pathname.startsWith(base + '/'))) return null
 const suffix = url.pathname.slice(base.length), api = new URL('/api/handset/' + root + suffix, url)
 if (request.method === 'GET' && suffix === '') {
  const response = await door(new Request(api), env, actor)
  if (!response) throw new Fault('not_found', 404)
  return render(await response.json() as Snapshot, url, request, env, actor)
 }
 if (request.method === 'GET' && root === 'callbacks' && suffix === '/settings') {
  const response = await door(new Request(new URL('/api/handset/callbacks', url)), env, actor)
  return callbackSettingsPage(await response!.json() as Snapshot)
 }
 if (request.method === 'GET' && root === 'operations' && /^\/[0-9a-f-]{36}\/export$/.test(suffix)) return door(new Request(api), env, actor)
 if (request.method !== 'POST' || !raw) throw new Fault('method_not_allowed', 405)
 // A refused new follow-up stays in Follow-ups with the person's entries; the refusal is still recorded.
 if (root === 'followups' && suffix === '') {
  let made: Snapshot
  try { made = await (await door(new Request(api, { method: 'POST' }), env, actor, formValue(root, suffix, raw)))!.json() as Snapshot } catch (error) {
   if (!(error instanceof Fault) || error.status >= 500) throw error
   await denied(env, actor, 'product.request')
   const current = await door(new Request(api), env, actor)
   return followupsPage(await current!.json() as Snapshot, url, request, env, actor, { code: error.code, status: error.status, values: raw })
  }
  return new Response(null, { status: 303, headers: { location: `${base}?followup=${encodeURIComponent(String((made.followup as Row).id))}#detail`, 'cache-control': 'no-store' } })
 }
 const response = await door(new Request(api, { method: 'POST' }), env, actor, formValue(root, suffix, raw))
 if (!response) throw new Fault('not_found', 404)
 const result = await response.json() as Snapshot
 if (root === 'rules' && suffix === '/preview') return consolePage('Review tested rule', details([
  ['Matched source', raw.sampleRecordId], ['Action', result.action], ['Exact message', result.message],
  ['Recipient', result.recipient ?? 'No customer recipient authorized'], ['Expires at', when(result.expiresAt)],
 ]) + '<p>Preview sent nothing. Customer contact and unqualified receivers remain held. Publication approves only this exact preview.</p>' + form(base + '/publish', 'Publish exact tested rule', hidden('previewId', result.previewId) + approval('publish exact tested rule', 'I approve this exact tested rule')))
 return new Response(null, { status: 303, headers: { location: base, 'cache-control': 'no-store' } })
}
