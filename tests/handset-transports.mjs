import assert from 'node:assert/strict'
import { test } from 'node:test'
import { post } from './helpers/handset-auth.mjs'
import { receptionistFixture, policyFor } from './helpers/handset-receptionist.mjs'

// A scope change while the receiving system answers preflight must take effect
// before the POST, not only at the start of the enclosing HTTP request.
test('Grant, STOP, case and policy changes during connector preflight prevent the subsequent provider write', async () => {
 for (const change of ['grant','stop','case','policy']) {
  const f = await receptionistFixture()
  try {
   await f.savePolicy()
   // The signature-verified source normally supplies From/To. Add that context
   // via its public ingress rather than planting a carrier receipt in native records.
   const { sourceFixture } = await import('./helpers/handset-sources.mjs')
   const source = await sourceFixture(f.runtime)
   const inbound = await source.callback({ CallSid: 'synthetic-handset-race-inbound', CallStatus: 'no-answer', SequenceNumber: '0', Timestamp: new Date().toISOString() })
   assert.equal(inbound.status, 200)
   const sourcedCase = (await inbound.json()).caseId
   const grant = await f.create('/api/handset/mcp/consent', { name: 'Preflight-race worker', definition: { scopes: ['send'], tools: ['outcome.work'], records: [sourcedCase], numbers: [], recipients: [], budgetCents: 0, policyRevision: 'owner-only-v1' }, expiresAt: Date.now() + 3600000, confirm: 'approve scoped credential' })
   const opened = await f.agent('outcomes', { callId: 'synthetic-handset-race-call', caseId: sourcedCase, language: 'en', callerName: 'Jordan Lee', callerEmail: 'synthetic-handset-race@example.test', identityBasis: 'callback_to_number_on_file', identityVerified: true }, grant.token)
   assert.equal(opened.status, 201)
   const outcome = (await opened.json()).outcome
   f.edges.orbitCheckHook = async () => {
    let response
    if (change === 'grant') response = await post(f.runtime, `/api/handset/grants/${grant.grant.id}/revoke`, {}, f.headers)
    if (change === 'stop') response = await post(f.runtime, '/api/handset/protection/stops', { numberId: source.numberId, recipient: '+15125550126', channel: 'all', reason: 'dnc', confirm: 'record outbound consent stop' }, f.headers)
    if (change === 'case') response = await post(f.runtime, `/api/handset/cases/${sourcedCase}`, { title: 'Human changed the callback plan', version: 1 }, f.headers)
    if (change === 'policy') response = await post(f.runtime, '/api/handset/receptionist/policy', { policy: policyFor('synthetic-handset-2'), expectedVersion: 1, confirm: 'set receptionist limits' }, f.headers)
    assert.ok([200,201].includes(response.status), await response.clone().text())
   }
   const response = await f.agent(`outcomes/${outcome.id}/handoffs/crm`, { summary: 'Approved context before preflight' }, grant.token)
   assert.ok([200,409].includes(response.status), change + ' ' + await response.clone().text())
   assert.equal(f.edges.effects.size, 0, change + ' changed while preflight was in flight')
   assert.equal(f.edges.requests.filter(r => r.host === f.edges.origins.orbit && r.method === 'POST').length, 0)
   const overview = await f.runtime.request('/api/handset/delivery', { headers: f.headers })
   assert.equal(overview.status, 200)
   const view = await overview.json()
   assert.ok(view.steps.some(s => s.outcome_id === outcome.id && ['sent','uncertain'].includes(s.state)), 'interrupted claim remains visible for repair')
   assert.ok(!JSON.stringify(view).includes('synthetic-handset-703'), 'no connector secret enters the repair inventory')
   assert.equal((await f.runtime.request('/api/handset/delivery')).status, 401)
  } finally { await f.runtime.close() }
 }
})
