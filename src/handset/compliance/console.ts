import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { denied } from '../audit/store'
import { Fault, choice, keys, owner, text, type ObjectValue } from '../core'
import { sourceDoor } from '../providers/sources'
import { complianceDoor, type Compliance } from './doors'
import { caseKinds, compliancePage, complianceDenied, type ComplianceView, type SourceChoice } from './pages'

function instant(value: unknown, name: string) {
 if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw new Fault('invalid_' + name)
 const at = Date.parse(value + ':00Z')
 if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 16) !== value) throw new Fault('invalid_' + name)
 return at
}

function preparation(raw: ObjectValue, sources: SourceChoice[]): ObjectValue {
 const kind = choice(raw.kind, Object.keys(caseKinds) as Compliance['kind'][], 'kind')
 const common = ['kind', 'sourceId', 'dueAt', 'confirm']
 const fields: Record<Compliance['kind'], string[]> = {
  port_pin: ['port_in_request_sid', 'phone_number_sid'],
  e911_move: ['endpointId', 'locationRecordId', 'changeNoticeRecordId'],
  brand_registration: ['sid', 'status', 'failure_reason'],
  tollfree_verification: ['sid', 'status', 'rejection_reason', 'error_code'],
  reputation: ['network', 'observedAt', 'label', 'evidenceRecordId'],
 }
 keys(raw, [...common, ...fields[kind]])
 const source = sources.find(s => s.id === raw.sourceId && s.status === 'active')
 if (!source) throw new Fault('source_inactive', 409)
 const report = Object.fromEntries(fields[kind].filter(key => raw[key] !== '').map(key => [key, raw[key]]))
 if (kind === 'port_pin') Object.assign(report, { port_in_phone_number_status: 'port_rejected', rejection_reason: 'INVALID_PIN' })
 if (kind === 'brand_registration' || kind === 'tollfree_verification') report.account_sid = source.account_id
 if (kind === 'tollfree_verification') {
  report.tollfree_phone_number = source.e164
  if (report.error_code !== undefined) report.error_code = Number(report.error_code)
 }
 if (kind === 'reputation') report.observedAt = instant(raw.observedAt, 'observedAt')
 return { sourceId: source.id, kind, report, dueAt: instant(raw.dueAt, 'dueAt'), confirm: raw.confirm }
}

/** Native forms share the API's current authority, identity and revision fences. */
export async function complianceConsole(request: Request, env: Bindings, actor: Session, raw?: ObjectValue): Promise<Response> {
 try { owner(actor) } catch (error) {
  if (!(error instanceof Fault)) throw error
  await denied(env, actor, 'compliance.request')
  return complianceDenied()
 }
 const url = new URL(request.url), base = '/app/compliance', suffix = url.pathname.slice(base.length)
 const match = suffix.match(/^\/([0-9a-f-]{36})(?:\/(review|follow-up|readback|submit))?$/)
 const creating = suffix === '/new', caseId = match?.[1], action = match?.[2] ?? ''
 if (suffix !== '' && !creating && !match) throw new Fault('not_found', 404)
 if (request.method === 'GET' && action || request.method === 'POST' && !creating && !action) throw new Fault('method_not_allowed', 405)
 if (!['GET', 'POST'].includes(request.method)) throw new Fault('method_not_allowed', 405)
 const api = async (path: string, value?: ObjectValue) => {
  const response = await complianceDoor(new Request(new URL('/api/handset/compliance' + path, url), { method: value ? 'POST' : 'GET' }), env, actor, value)
  if (!response) throw new Fault('not_found', 404)
  return response
 }
 const sourceResponse = await sourceDoor(new Request(new URL('/api/handset/sources', url), { headers: request.headers }), env, actor)
 if (!sourceResponse) throw new Fault('source_unavailable', 503)
 const { sources } = await sourceResponse.json() as { sources: SourceChoice[] }
 const people = (await env.DB.prepare('SELECT id,display_name,role,status,version FROM oa_operators ORDER BY display_name').all<ComplianceView['people'][number]>()).results
 const view: ComplianceView = { cases: [], sources, people, actorId: actor.operator.id, actorVersion: actor.operator.version, creating, kind: choice(creating ? raw?.kind ?? url.searchParams.get('kind') ?? 'port_pin' : 'port_pin', Object.keys(caseKinds) as Compliance['kind'][], 'kind') }
 const load = async () => {
  if (caseId) Object.assign(view, await (await api('/' + caseId)).json())
  else if (!creating) view.cases = (await (await api('')).json() as { cases: Compliance[] }).cases
 }
 await load()
 if (request.method === 'GET') return compliancePage(view)
 if (!raw) throw new Fault('invalid_object')
 try {
  let value: ObjectValue
  if (creating) value = preparation(raw, sources)
  else if (action === 'review') { keys(raw, ['revision', 'note', 'confirm']); value = { ...raw, revision: Number(raw.revision) } }
  else if (action === 'follow-up') {
   keys(raw, ['revision', 'ownerId', 'dueAt', 'nextAction', 'confirm'])
   value = { ...raw, revision: Number(raw.revision), dueAt: instant(raw.dueAt, 'dueAt') }
  } else {
   keys(raw, action === 'readback' ? ['revision', 'confirm'] : ['revision'])
   value = { ...raw, revision: Number(raw.revision) }
  }
  const result = await (await api(creating ? '' : '/' + caseId + '/' + action, value)).json() as { case?: Compliance; state?: string; reason?: string }
  if (result.state === 'held') {
   await load()
   view.notice = { message: text(result.reason, 'reason', 2000), status: 200, held: true }
   return compliancePage(view)
  }
  return new Response(null, { status: 303, headers: { location: base + '/' + (result.case?.id ?? caseId), 'cache-control': 'no-store' } })
 } catch (error) {
  if (!(error instanceof Fault)) throw error
  await denied(env, actor, 'compliance.request')
  await load()
  view.draft = { action, values: raw }
  view.notice = { message: refusal(error), status: error.status }
  return compliancePage(view)
 }
}

function refusal(error: Fault) {
 const messages: Record<string, string> = {
  compliance_revision_conflict: 'This case changed. Your entries are retained. Review the current history and confirm again before saving.',
  provider_receipt_unavailable_case_still_due: 'The provider receipt is unavailable. The previous observation is retained and the case remains due to its named owner. Try readback again later.',
  provider_receipt_identity_mismatch: 'The provider receipt does not match this exact account, number and resource. No observation was accepted; the case remains due.',
  future_followup_required: 'Choose a future due time. Your next action and selected owner are retained.',
  source_inactive: 'This source is no longer authorized. Restore current source authority before preparing, reviewing or reading a carrier receipt.',
  named_compliance_owner_required: 'Only the current named owner can review this preparation. Assign continued follow-up to a current active owner first.',
 }
 return messages[error.code] ?? error.code.replaceAll('_', ' ') + '. Your entries are retained; no provider change occurred.'
}
