import { queuedEntrypoint } from '@runeditrun/rer/queued-entry'
const queued = await queuedEntrypoint(import.meta.url, 'verify:runtime')
if (queued !== null) process.exit(queued)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'

test('Emitted Worker serves health and public Lobby with honest missing routes', async () => {
  const runtime = await openHandset()
  try {
    const health = await (await runtime.request('/health')).json()
    assert.equal(health.status, 'ok')
    assert.equal(health.ok, true)
    assert.equal((await runtime.request('/')).status, 200)
    for (const path of ['/missing', '/health/extra']) assert.equal((await runtime.request(path)).status, 404, path)
    // Product API namespaces now require a session before dispatch/404.
    for (const path of ['/api', '/api/missing']) assert.equal((await runtime.request(path)).status, 401, path)
  } finally { await runtime.close() }
})
