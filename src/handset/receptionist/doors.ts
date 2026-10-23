import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, input, json, text, type ObjectValue } from '../core'
import type { AppliedPolicy } from '../audit/policy'
import type { Grant } from '../authority/store'
import { decide } from './exceptions'
import * as ops from './operations'
import type { ExceptionRow, Outcome } from './model'
import { receptionistPage } from './pages'
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
  if (html) return receptionistPage(current, exceptions, outcomes, actor.operator.id)
  return json({ policy: current ? { version: current.version, ...current.policy } : null, history: (await policyHistory(db)).map(h => ({ version: h.version, ownerId: h.owner_id, createdAt: h.created_at })), exceptions: exceptions.map(x => ({ ...x, requested: JSON.parse(x.requested), evidence: JSON.parse(x.evidence) })), outcomes })
 }
 if (request.method !== 'POST' || !data) throw new Fault('method_not_allowed', 405)
 if (action === '/policy') {
  const value = html ? { ...data, policy: parseJson(data.policy), expectedVersion: Number(data.expectedVersion) } : data
  const saved = await writePolicy(env, actor, value)
  return html ? Response.redirect(new URL(base, url).toString(), 303) : json(saved, 201)
 }
 const decision = action.match(/^\/exceptions\/([0-9a-f-]{36})\/decision$/)
 if (decision) {
  const row = await decide(env, actor, decision[1], data)
  return html ? Response.redirect(new URL(base + '#exception-' + decision[1], url).toString(), 303) : json({ id: row!.id, status: row!.status, decidedBy: row!.decided_by, note: row!.note })
 }
 throw new Fault('not_found', 404)
}
function parseJson(value: unknown) { try { return JSON.parse(text(value, 'policy', 20000)) } catch (error) { if (error instanceof Fault) throw error; throw new Fault('invalid_policy_json') } }
