import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { consolePage, escape as e, field, hidden, Fault, keys, type ObjectValue } from '../core'
import { rulesPage } from './pages'
import { followupsPage } from '../followups/pages'
import { recoveryPage } from '../recovery/pages'
import { intakeErrorMessage, intakeHours } from '../recovery/intake-settings'
import { operationsPage } from '../operations/pages'
import { callbacksPage } from '../callbacks/pages'

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
export const nav = '<nav aria-label="Customer work"><a href="/app/rules">Rules</a> · <a href="/app/followups">Follow-up review</a> · <a href="/app/recovery">Missed-call recovery</a> · <a href="/app/callbacks">Callbacks</a> · <a href="/app/operations">Continuity review</a></nav>'
export const bounds = (text: string) => `<p role="status">${e(text)}</p>`

type Door = (request: Request, env: Bindings, actor: Session, value?: ObjectValue) => Promise<Response | null>
const pages: Record<string, (snapshot: Snapshot, url: URL) => Promise<Response>> = { rules: rulesPage, followups: followupsPage, recovery: recoveryPage, callbacks: callbacksPage, operations: operationsPage }
function formValue(root: string, suffix: string, raw: ObjectValue): ObjectValue {
 const value = { ...raw }
 for (const key of ['revision', 'expectedRevision', 'delayMinutes', 'startMinute', 'endMinute', 'maxAttempts', 'retrySeconds']) if (key in value) value[key] = Number(value[key])
 if (root === 'recovery' && suffix === '/policies') {
  keys(value, ['sourceId','revision','timezone','opens','closes','day1','day2','day3','day4','day5','day6','day7','confirm'])
  return { sourceId: value.sourceId, revision: value.revision, timezone: value.timezone, hours: intakeHours(value), confirm: value.confirm }
 }
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
  return render(await response.json() as Snapshot, url)
 }
 if (request.method === 'GET' && root === 'operations' && /^\/[0-9a-f-]{36}\/export$/.test(suffix)) return door(new Request(api), env, actor)
 if (request.method !== 'POST' || !raw) throw new Fault('method_not_allowed', 405)
 let response: Response | null
 try {
  response = await door(new Request(api, { method: 'POST' }), env, actor, formValue(root, suffix, raw))
 } catch (error) {
  if (root !== 'recovery' || !['/policies', '/policies/revoke'].includes(suffix) || !(error instanceof Fault) || error.status === 401 || error.status === 403 && error.code !== 'explicit_intake_approval_required') throw error
  const current = await door(new Request(new URL('/api/handset/recovery', url)), env, actor)
  if (!current) throw new Fault('not_found', 404)
  if (!current.ok) return current
  const page = await render({ ...await current.json() as Snapshot, intakeDraft: raw, intakeError: intakeErrorMessage(error) })
  return new Response(page.body, { status: error.status, headers: page.headers })
 }
 if (!response) throw new Fault('not_found', 404)
 const result = await response.json() as Snapshot
 if (root === 'rules' && suffix === '/preview') return consolePage('Review tested rule', nav + details([
  ['Matched source', raw.sampleRecordId], ['Action', result.action], ['Exact message', result.message],
  ['Recipient', result.recipient ?? 'No customer recipient authorized'], ['Expires at', when(result.expiresAt)],
 ]) + '<p>Preview sent nothing. Customer contact and unqualified receivers remain held. Publication approves only this exact preview.</p>' + form(base + '/publish', 'Publish exact tested rule', hidden('previewId', result.previewId) + approval('publish exact tested rule', 'I approve this exact tested rule')))
 return new Response(null, { status: 303, headers: { location: base, 'cache-control': 'no-store' } })
}
