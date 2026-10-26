import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { post, signIn } from './handset-auth.mjs'
import { createEdges } from './handset-edges.mjs'
import { openHandset } from './handset-worker.mjs'

const orbitTarget = 'opportunities/synthetic-handset-720/handoffs/synthetic-handset-721'
const stagger = () => { const d = new Date(Date.now() + 86400000); return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).formatToParts(d).find(p => p.type === 'weekday').value }
export const policyFor = (namedPerson, supportConversations = []) => ({
 businessName: 'Austin Service Co.', timezone: 'America/Chicago',
 // Staffed hours exist only tomorrow, so every call placed now is after hours.
 hours: [{ day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(stagger()), start: '09:00', end: '17:00' }],
 services: [{ id: 'furnace', name: 'Furnace repair visit', eventTypeId: '01JSYNTHETICEVENTTYPE0001A', bookingPage: 'austin/furnace', minutes: 60, depositCents: 5000 }],
 maxDepositCents: 5000, maxDiscountCents: 500, maxRefundCents: 0, callbackMinutes: 45, exceptionOwnerId: namedPerson,
 knowledge: [{ topic: 'service_area', value: 'Austin and Round Rock', version: 'k-12' }, { topic: 'deposit', value: '$50.00', version: 'k-12' }], orbitTarget, supportConversations,
})
export async function receptionistFixture({ connectors = true, clockTime } = {}) {
 const edges = connectors ? createEdges() : null
 const runtime = await openHandset({ twilio: true, edges, clockTime })
 const { cookie } = await signIn(runtime), headers = { cookie }
 await runtime.sql('UPDATE oa_operators SET status=?,role=? WHERE id=?', 'active', 'owner', 'synthetic-handset-2')
 const named = await signIn({ ...runtime, ownerEmail: 'synthetic-handset-2@example.test' })
 const create = async (path, value, who = headers, status = 201) => { const response = await post(runtime, path, value, who); assert.equal(response.status, status, await response.clone().text()); return response.json() }
 const cases = []
 for (const title of ['English after-hours call', 'Llamada en español fuera de horario', 'Lost responses', 'Conflicting knowledge', 'Refund and emergency']) cases.push((await create('/api/handset/cases', { title })).current.id)
 const definition = { scopes: ['send'], tools: ['outcome.work'], records: cases, numbers: [], recipients: [], budgetCents: 30000, policyRevision: 'owner-only-v1' }
 const issued = await create('/api/handset/mcp/consent', { name: 'After-hours receptionist', definition, expiresAt: Date.now() + 3600000, confirm: 'approve scoped credential' })
 const agent = (path, data, token = issued.token) => post(runtime, '/api/handset/application/receptionist/' + path, data, { authorization: 'Bearer ' + token })
 const agentGet = (path, token = issued.token) => runtime.request('/api/handset/application/receptionist/' + path, { headers: { authorization: 'Bearer ' + token } })
 const ok = async (path, data, status = 200) => { const response = await agent(path, data); assert.equal(response.status, status, path + ' ' + await response.clone().text()); return response.json() }
 const savePolicy = (policy = policyFor('synthetic-handset-2', cases.map(caseId => ({ caseId, conversationId: 'synthetic-handset-710' }))), expectedVersion = 0) => create('/api/handset/receptionist/policy', { policy, expectedVersion, confirm: 'set receptionist limits' })
 const open = (n, language, caseId, extra = {}) => ok('outcomes', { callId: `synthetic-handset-call-${n}`, caseId, language, callerName: language === 'es' ? 'Rosa García' : 'Jordan Lee', callerEmail: `synthetic-handset-caller-${n}@example.test`, identityBasis: 'callback_to_number_on_file', identityVerified: true, paymentMethodRef: `synthetic-handset-pm-${n}` }, 201)
 // The carrier's signed callback: the only way a caller's key press authorizes a charge.
 async function carrier(authorization, step, fields, { sign = true } = {}) {
  const path = `/providers/twilio/receptionist/${authorization}/${step}`, data = { AccountSid: 'synthetic-handset-800', CallStatus: 'in-progress', ...fields }
  let payload = new URL(path, runtime.origin).href
  for (const key of Object.keys(data).sort()) payload += key + data[key]
  return runtime.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sign ? { 'x-twilio-signature': createHmac('sha1', 'synthetic-handset-500').update(payload).digest('base64') } : {}) }, body: new URLSearchParams(data).toString() })
 }
 return { runtime, edges, headers, named, create, cases, issued, agent, agentGet, ok, savePolicy, open, carrier, orbitTarget }
}
export const mailTo = (runtime, email) => runtime.mails.filter(m => m.personalizations?.some(p => p.to?.some(t => t.email === email)))
export const mailText = message => message.content.find(part => part.type === 'text/plain').value
