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


async function apiFixture(scopes, tools) {
 const f = await receptionistFixture()
 const issued = await f.create('/api/handset/mcp/consent', { name: 'Scoped REST client', definition: { scopes, tools, records: f.cases.slice(0, 2), numbers: [], recipients: [], budgetCents: 0, policyRevision: 'owner-only-v1' }, expiresAt: Date.now() + 3600000, confirm: 'approve scoped credential' })
 const headers = { authorization: 'Bearer ' + issued.token }
 const read = path => f.runtime.request('/api/handset/v1' + path, { headers })
 const write = (path, value, key) => post(f.runtime, '/api/handset/v1' + path, value, { ...headers, ...(key ? { 'idempotency-key': key } : {}) })
 return { ...f, restGrant: issued, read, write }
}

test('Versioned REST pagination and OpenAPI preserve exact selected-case scope and immediate credential revocation', async () => {
 const f = await apiFixture(['read'], ['case.read'])
 try {
  const document = await f.read('/openapi.json')
  assert.equal(document.status, 200)
  const spec = await document.json(); assert.equal(spec.openapi, '3.1.0'); assert.ok(spec.paths['/drafts'].post.parameters.some(p => p.name === 'Idempotency-Key'))
  const first = await (await f.read('/cases?limit=1')).json()
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor)
  const second = await (await f.read('/cases?limit=1&cursor=' + first.nextCursor)).json()
  assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null)
  assert.deepEqual([first.items[0].current.id, second.items[0].current.id].sort(), f.cases.slice(0, 2).sort())
  assert.equal((await f.read('/cases/' + f.cases[2])).status, 403)
  assert.equal((await f.read('/cases?cursor=' + f.cases[2])).status, 403)
  assert.equal((await f.runtime.request('/api/handset/v1/cases', { headers: f.headers })).status, 401, 'a native cookie is not an application credential')
  assert.equal((await post(f.runtime, `/api/handset/grants/${f.restGrant.grant.id}/revoke`, {}, f.headers)).status, 200)
  assert.equal((await f.read('/cases')).status, 401)
  assert.equal((await f.write('/prepare', {})).status, 401)
 } finally { await f.runtime.close() }
})

test('Versioned draft idempotency survives replay, conflicting bodies, races and restart without publishing or repeating work', async () => {
 const f = await apiFixture(['draft'], ['comment.draft'])
 try {
  const body = { caseId: f.cases[0], text: 'Draft an Austin estimate; no message has been sent' }
  assert.equal((await f.write('/drafts', body)).status, 400)
  const initial = await f.write('/drafts', body, 'synthetic-handset-draft-1'); assert.equal(initial.status, 201)
  const draft = await initial.json(); assert.equal(draft.published, false)
  const replay = await f.write('/drafts', body, 'synthetic-handset-draft-1'); assert.equal(replay.status, 200); assert.equal((await replay.json()).id, draft.id)
  assert.equal((await f.write('/drafts', { ...body, text: 'Changed proposal' }, 'synthetic-handset-draft-1')).status, 409)
  const racing = await Promise.all([1, 2].map(() => f.write('/drafts', body, 'synthetic-handset-draft-race')))
  assert.ok(racing.every(r => [200,201,409].includes(r.status)))
  const recovered = await (await f.write('/drafts', body, 'synthetic-handset-draft-race')).json()
  await f.runtime.restart()
  assert.equal((await (await f.write('/drafts', body, 'synthetic-handset-draft-race')).json()).id, recovered.id)
  assert.equal((await f.runtime.sql('SELECT count(*) AS n FROM hnd_drafts WHERE grant_id=?', f.restGrant.grant.id)).results[0].n, 2)
  assert.equal((await f.read('/cases')).status, 403)
  assert.equal(f.edges.effects.size, 0)
 } finally { await f.runtime.close() }
})

test('Versioned API rate limits are durable per credential and authentication still refuses revoked callers', async () => {
 const f = await apiFixture(['read'], ['case.read'])
 try {
  let limited
  for (let n = 0; n < 122; n++) {
   const response = await f.read('/openapi.json')
   if (response.status === 429) { limited = response; break }
   assert.equal(response.status, 200)
  }
  assert.ok(limited, 'the bounded minute bucket refuses excess requests')
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  assert.equal(limited.headers.get('ratelimit-remaining'), '0')
  await f.runtime.restart()
  // A restart retains the rate bucket; current auth remains an earlier fence.
  assert.equal((await post(f.runtime, `/api/handset/grants/${f.restGrant.grant.id}/revoke`, {}, f.headers)).status, 200)
  assert.equal((await f.read('/openapi.json')).status, 401)
 } finally { await f.runtime.close() }
})
