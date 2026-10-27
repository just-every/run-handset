import assert from 'node:assert/strict'
import { post } from './handset-auth.mjs'
import { b64, business, newPrompt, people, promptFixture, registerPeople, wavBytes } from './handset-prompts.mjs'

export async function mediaSecurity() {
 const requests = [], bodies = []
 let mode = 'valid', revoke, callSid
 const f = await promptFixture({ knowledgeEdge: async (request, Response) => {
  if (!request.url.startsWith('https://api.twilio.com/2010-04-01/Accounts/')) return null
  requests.push({ url: request.url, authorization: request.headers.get('authorization') })
  if (mode === 'revoke' && request.url.endsWith('.json')) await revoke()
  if (mode === 'redirect-meta' || mode === 'redirect-audio' && request.url.endsWith('.wav')) return new Response(null, { status: 302, headers: { location: 'https://example.invalid/collect' } })
  if (request.url.endsWith('.json')) return Response.json({ account_sid: 'synthetic-handset-502', call_sid: callSid, status: 'completed' })
  const bytes = mode === 'malformed' ? wavBytes().subarray(0, -2) : wavBytes()
  return new Response(bytes, { headers: { 'content-type': mode === 'mime' ? 'text/html' : 'audio/wav' } })
 } })
 try {
  await registerPeople(f)
  const prompt = await newPrompt(f, 'Reception security check', 'main_attendant')
  const base = `/api/handset/prompts/${prompt.id}`, versions = base + '/versions'
  const upload = { source: 'upload', language: 'en', variant: 'always', audioBase64: b64(wavBytes()) }
  // A valid current owner still saves a draft; a hostile browser cannot borrow that session.
  const valid = await f.ok('POST', versions, upload, 201)
  for (const [path, body] of [[versions, upload], ['/api/handset/sources/revoke', { sourceId: f.source.source.id }], ['/app/sources/revoke', { sourceId: f.source.source.id }]]) {
   for (const headers of [{ origin: 'https://example.invalid' }, { origin: f.runtime.origin, 'sec-fetch-site': 'cross-site' }, { origin: '' }]) {
    const refused = await post(f.runtime, path, body, { ...f.headers, ...headers })
    assert.equal(refused.status, 403, path); bodies.push(await refused.text())
   }
  }
  assert.equal((await f.ok('GET', '/api/handset/prompts')).versions.length, 1)
  assert.equal((await f.ok('GET', '/api/handset/sources')).sources[0].status, 'active')
  let n = 0
  for (const scenario of ['redirect-meta', 'redirect-audio', 'mime', 'malformed', 'valid', 'revoke']) {
   const recording = await f.ok('POST', base + '/phone-recordings', { sourceId: f.source.source.id, destination: people[0].destination, language: 'en', variant: 'always' }, 201)
   callSid = 'synthetic-handset-security-' + ++n
   const fields = { CallSid: callSid, From: business, To: people[0].destination }
   assert.equal((await f.signed(recording.providerPath, fields)).status, 200)
   assert.equal((await f.signed(recording.providerPath + '/pin', { ...fields, Digits: recording.pin })).status, 200)
   mode = scenario
   revoke = () => f.ok('POST', '/api/handset/sources/revoke', { sourceId: f.source.source.id })
   const before = requests.length
   const response = await f.signed(recording.providerPath + '/recorded', { ...fields, RecordingSid: 'synthetic-handset-981', RecordingUrl: 'https://example.invalid/collect' })
   assert.equal(response.status, ({ valid: 200, malformed: 422, mime: 502, revoke: 409 })[scenario] ?? 503, scenario)
   bodies.push(await response.text())
   const attempted = requests.slice(before)
   assert.equal(attempted.length, ['redirect-meta', 'revoke'].includes(scenario) ? 1 : 2, scenario + ' sends no follow-up after refusal')
   assert.ok(attempted.every(r => new URL(r.url).origin === 'https://api.twilio.com'))
   assert.ok(attempted.every(r => r.authorization === 'Basic ' + Buffer.from(f.source.account + ':synthetic-handset-500').toString('base64')))
  }
  const listing = await f.ok('GET', '/api/handset/prompts')
  assert.deepEqual(listing.versions.map(v => v.source).sort(), ['phone_recording', 'upload'])
  assert.equal(listing.versions.find(v => v.source === 'upload').id, valid.id)
  for (const path of ['/api/handset/sources', '/app/sources', '/api/handset/prompts', '/app/prompts', '/api/handset/audit/export']) {
   const response = await f.runtime.request(path, { headers: f.headers }); assert.equal(response.status, 200)
   bodies.push(await response.text())
  }
  const tables = await f.runtime.sql("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'hnd_%'")
  assert.ok(tables.results.length > 0)
  for (const { name } of tables.results) bodies.push(JSON.stringify((await f.runtime.sql('SELECT * FROM "' + name + '"')).results))
  for (const secret of ['synthetic-handset-500', 'synthetic-handset-970', 'synthetic-handset-7-synthetic-handset-8', Buffer.from(f.source.account + ':synthetic-handset-500').toString('base64')]) assert.ok(!bodies.join('\n').includes(secret), 'private bindings stay out of responses, ordinary exports and native storage')
 } finally { await f.runtime.close() }
}
