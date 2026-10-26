import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, input, json, type ObjectValue } from '../core'
import { settingsSave } from '../refusal'
import type { AppliedPolicy } from '../audit/policy'
import type { Grant } from '../authority/store'
import { decide } from './exceptions'
import * as ops from './operations'
import { policy as parsePolicy, type ExceptionRow, type Outcome } from './model'
import { receptionistPage, receptionistSettingsPage } from './pages'
import { currentPolicy, loadOutcome, openOutcome, policyHistory, readOutcome, writePolicy } from './store'

const agentBase = '/api/handset/application/receptionist'
type Op = (c: ops.Ctx, value: ObjectValue) => Promise<unknown>
const routes: Record<string, [Op, number]> = {
 availability: [ops.availability, 200], knowledge: [ops.knowledge, 200], booking: [ops.booking, 200], 'deposit/propose': [ops.proposeDeposit, 200], deposit: [ops.deposit, 200],
 'handoffs/crm': [ops.crmHandoff, 200], 'handoffs/support': [ops.supportHandoff, 200], escalations: [ops.escalate, 200], refund: [ops.refundDeposit, 200], reconcile: [ops.reconcile, 200],
}
/** The receptionist's own door: a scoped application credential, one work identity per call. */
export async function agentDoor(request: Request, env: Bindings, grant: Grant, applied: AppliedPolicy): Promise<Response | null> {
 const path = new URL(request.url).pathname
 if (path !== agentBase && !path.startsWith(agentBase + '/')) return null
 const rest = path.slice(agentBase.length)
 if (rest === '/outcomes' && request.method === 'POST') {
  const opened = await openOutcome(env, grant, await input(request), applied)
  return json({ ...(await readOutcome(env.DB, opened.outcome)), replay: opened.replay }, opened.replay ? 200 : 201)
 }
 const match = rest.match(/^\/outcomes\/([0-9a-f-]{36})(?:\/(.+))?$/)
 if (!match) throw new Fault('not_found', 404)
 const loaded = await loadOutcome(env, grant, match[1]), ctx: ops.Ctx = { env, grant, applied, outcome: loaded.outcome, policy: loaded.policy, policyVersion: loaded.policyVersion }
 if (!match[2] && request.method === 'GET') return json(await readOutcome(env.DB, loaded.outcome))
 const route = match[2] ? routes[match[2]] : undefined
 if (!route) throw new Fault('not_found', 404)
 if (request.method !== 'POST') throw new Fault('method_not_allowed', 405)
 return json(await route[0](ctx, await input(request)), route[1])
}
/** The named person's door: owner session only. Agent credentials never reach it. */
export async function ownerDoor(request: Request, env: Bindings, actor: Session, data?: ObjectValue): Promise<Response | null> {
 const url = new URL(request.url), path = url.pathname, html = path.startsWith('/app/'), base = html ? '/app/receptionist' : '/api/handset/receptionist'
 if (path !== base && !path.startsWith(base + '/')) return null
 const action = path.slice(base.length), db = env.DB
 if (request.method === 'GET' && !action) {
  const current = await currentPolicy(db)
  const exceptions = (await db.prepare('SELECT * FROM hnd_rx_exceptions ORDER BY (status=\'open\') DESC, created_at DESC LIMIT 100').all<ExceptionRow>()).results
  const outcomes = (await db.prepare("SELECT o.*,COALESCE((SELECT group_concat(kind||' '||state||' — '||replace(reason,'_',' '),'; ') FROM hnd_rx_steps s WHERE s.outcome_id=o.id),'') AS states FROM hnd_rx_outcomes o ORDER BY created_at DESC LIMIT 50").all<Outcome & { states: string }>()).results
  if (html) return receptionistPage(current, exceptions, outcomes)
  return json({ policy: current ? { version: current.version, ...current.policy } : null, history: (await policyHistory(db)).map(h => ({ version: h.version, ownerId: h.owner_id, createdAt: h.created_at })), exceptions: exceptions.map(x => ({ ...x, requested: JSON.parse(x.requested), evidence: JSON.parse(x.evidence) })), outcomes })
 }
 if (html && request.method === 'GET' && action === '/settings') return receptionistSettingsPage(await currentPolicy(db), actor.operator.id)
 if (request.method !== 'POST' || !data) throw new Fault('method_not_allowed', 405)
 if (action === '/policy') {
  if (!html) return json(await writePolicy(env, actor, data), 201)
  // A refused save keeps the person in the limits editor with every entry.
  return settingsSave(env, actor, { action: path, values: data }, async () => {
   await writePolicy(env, actor, { confirm: data.confirm, policy: policyFields(data), expectedVersion: Number(data.expectedVersion) })
   return Response.redirect(new URL(base, url).toString(), 303)
  }, async refusal => receptionistSettingsPage(await currentPolicy(db), actor.operator.id, { ...refusal, field: refusedRow(data, refusal.code) }))
 }
 const decision = action.match(/^\/exceptions\/([0-9a-f-]{36})\/decision$/)
 if (decision) {
  const row = await decide(env, actor, decision[1], data)
  return html ? Response.redirect(new URL(base + '#exception-' + decision[1], url).toString(), 303) : json({ id: row!.id, status: row!.status, decidedBy: row!.decided_by, note: row!.note })
 }
 throw new Fault('not_found', 404)
}
// Row refusals by the settings form's row prefix: the field each code is about.
const rowFields: [string, Record<string, string>][] = [
 ['hours', { invalid_hours: 'start', invalid_start: 'start', invalid_end: 'end' }],
 ['services', { invalid_policy: 'id', invalid_serviceId: 'id', invalid_serviceName: 'name', invalid_eventTypeId: 'eventTypeId', invalid_bookingPage: 'bookingPage', invalid_minutes: 'minutes', invalid_depositCents: 'deposit', service_deposit_exceeds_limit: 'deposit' }],
 ['knowledge', { invalid_topic: 'topic', invalid_value: 'value', invalid_version: 'version' }],
 ['support', { invalid_caseId: 'caseId', invalid_conversationId: 'conversationId' }],
]
/** The field of the staffed day, service, answer or mapping a refusal is about: the first row the policy reader refuses on its own. */
function refusedRow(data: ObjectValue, code: string) {
 if (code === 'duplicate_service') { const ids = Object.keys(data).filter(key => /^services\.\d+\.id$/.test(key)); return ids.find((key, n) => data[key] && ids.slice(0, n).some(other => data[other] === data[key])) }
 for (const [prefix, names] of rowFields) {
  if (!names[code]) continue
  for (const row of new Set(Object.keys(data).filter(key => key.startsWith(prefix + '.')).map(key => key.split('.')[1]))) {
   const alone = Object.fromEntries(Object.entries(data).filter(([key]) => !key.startsWith(prefix + '.') || key.startsWith(`${prefix}.${row}.`)))
   try { parsePolicy(policyFields(alone)) } catch (error) { if (error instanceof Fault && error.code === code) return `${prefix}.${row}.${names[code]}` }
  }
 }
}
/** The settings form's labelled fields as one policy; the policy reader still checks every value. */
function policyFields(data: ObjectValue) {
 const value = (name: string) => typeof data[name] === 'string' ? String(data[name]).trim() : ''
 const cents = (name: string) => value(name) === '' ? Number.NaN : Math.round(Number(value(name)) * 100)
 const rows = (prefix: string, names: string[]) => [...new Set(Object.keys(data).filter(key => key.startsWith(prefix + '.')).map(key => key.split('.')[1]))].sort((a, b) => Number(a) - Number(b))
  .map(n => Object.fromEntries(names.map(name => [name, value(`${prefix}.${n}.${name}`)]))).filter(row => Object.values(row).some(Boolean))
 const hours = rows('hours', ['start', 'end']).length ? [0, 1, 2, 3, 4, 5, 6].flatMap(day => value(`hours.${day}.start`) || value(`hours.${day}.end`) ? [{ day, start: value(`hours.${day}.start`), end: value(`hours.${day}.end`) }] : []) : []
 return {
  businessName: value('businessName'), timezone: value('timezone'), hours, callbackMinutes: Number(value('callbackMinutes')), exceptionOwnerId: value('exceptionOwnerId'), orbitTarget: value('orbitTarget'),
  maxDepositCents: cents('maxDeposit'), maxDiscountCents: cents('maxDiscount'), maxRefundCents: cents('maxRefund'),
  // The prefilled minutes and deposit alone don't make the empty "Add a service" row a service.
  services: rows('services', ['id', 'name', 'eventTypeId', 'bookingPage', 'minutes', 'deposit']).filter(s => s.id || s.name || s.eventTypeId || s.bookingPage).map(s => ({ id: s.id, name: s.name, eventTypeId: s.eventTypeId, bookingPage: s.bookingPage, minutes: Number(s.minutes), depositCents: s.deposit === '' ? 0 : Math.round(Number(s.deposit) * 100) })),
  knowledge: rows('knowledge', ['topic', 'value', 'version']), supportConversations: rows('support', ['caseId', 'conversationId']),
 }
}
