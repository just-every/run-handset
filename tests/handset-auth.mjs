import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { deniedPrivateDoors, mailLink, post, privateWrites, signIn } from './helpers/handset-auth.mjs'

test('Native mail links are single-use, hash-stored, expiring and fail closed', async () => {
  const runtime = await openHandset()
  try {
    const before = runtime.mails.length
    const unknown = await post(runtime, '/auth/magic-link', { email: 'synthetic-handset-7@example.test' })
    const inactive = await post(runtime, '/auth/magic-link', { email: 'synthetic-handset-2@example.test' })
    assert.equal(unknown.status, 202)
    assert.equal(inactive.status, unknown.status)
    assert.equal(await inactive.text(), await unknown.text())
    assert.equal(runtime.mails.length, before)
    const { cookie, link, response } = await signIn(runtime)
    const token = link.searchParams.get('token')
    assert.match(response.headers.get('set-cookie'), /; Secure/)
    assert.match(response.headers.get('set-cookie'), /; HttpOnly/)
    assert.match(response.headers.get('set-cookie'), /; SameSite=Lax/)
    const stored = await runtime.db.prepare('SELECT token_hash,created_at,expires_at FROM oa_tokens').first()
    assert.notEqual(stored.token_hash, token)
    assert.ok(stored.expires_at > stored.created_at && stored.expires_at - stored.created_at <= 15 * 60 * 1000)
    const session = await runtime.db.prepare('SELECT token_hash,created_at,expires_at FROM oa_sessions').first()
    assert.notEqual(session.token_hash, cookie.split('=')[1])
    assert.ok(session.expires_at > session.created_at && session.expires_at - session.created_at <= 30 * 86400 * 1000)
    assert.equal((await post(runtime, '/auth/confirm', { token })).status, 400, 'replay')
    assert.equal((await post(runtime, '/auth/magic-link', { email: runtime.ownerEmail })).status, 202)
    const expiredLink = mailLink(runtime.mails.at(-1))
    for (const method of ['GET', 'HEAD']) {
      const preview = await runtime.request(expiredLink.pathname + expiredLink.search, { method })
      assert.equal(preview.status, 200)
      assert.equal(preview.headers.get('set-cookie'), null)
    }
    await runtime.db.prepare('UPDATE oa_tokens SET expires_at=0 WHERE consumed_at IS NULL').run()
    assert.equal((await post(runtime, '/auth/confirm', { token: expiredLink.searchParams.get('token') })).status, 400, 'expired link')
    await runtime.db.prepare('UPDATE oa_sessions SET expires_at=0').run()
    await deniedPrivateDoors(runtime, cookie)
    runtime.setMailFailure(true)
    assert.equal((await post(runtime, '/auth/magic-link', { email: runtime.ownerEmail })).status, 503)
    const failed = mailLink(runtime.mails.at(-1))
    assert.equal((await post(runtime, '/auth/confirm', { token: failed.searchParams.get('token') })).status, 400)
    assert.equal((await runtime.db.prepare('SELECT COUNT(*) AS n FROM oa_sessions').first()).n, 1, 'failed mail creates no session')
  } finally { await runtime.close() }
})

test('Every current private document and native handler denies unsigned and revoked access', async () => {
  const runtime = await openHandset()
  try {
    await deniedPrivateDoors(runtime)
    const { cookie } = await signIn(runtime)
    assert.equal((await runtime.request('/app', { headers: { cookie } })).status, 200)
    const session = await (await runtime.request('/auth/session', { headers: { cookie } })).json()
    assert.equal((await post(runtime, '/auth/session/revoke', { sessionId: session.id }, { cookie })).status, 204)
    await deniedPrivateDoors(runtime, cookie)
    const next = await signIn(runtime)
    const signedOut = await post(runtime, '/auth/signout', {}, { cookie: next.cookie })
    assert.equal(signedOut.status, 204)
    assert.match(signedOut.headers.get('set-cookie'), /Max-Age=0/)
    await deniedPrivateDoors(runtime, next.cookie)
    assert.equal((await post(runtime, '/auth/review-session', {})).status, 403)
    assert.equal((await runtime.request('/auth/one-click?person=synthetic-handset-1')).status, 404)
  } finally { await runtime.close() }
})

test('Public doors stay bounded and cross-origin or forged callbacks cause no effects', async () => {
  const runtime = await openHandset()
  try {
    for (const path of ['/', '/signin', '/setup/state', '/health', '/.well-known/rer-dependencies', '/auth/dependencies/status']) {
      const response = await runtime.request(path)
      assert.equal(response.status, 200, path)
      if (path !== '/' && path !== '/signin') assert.ok(!(await response.text()).includes(runtime.ownerEmail), path)
    }
    assert.equal((await runtime.request('/setup/state', { method: 'POST' })).status, 405)
    const { cookie } = await signIn(runtime)
    const before = await runtime.db.prepare('SELECT COUNT(*) AS n FROM oa_operators').first()
    for (const [path, input] of [...privateWrites, ['/auth/signout', {}], ['/auth/magic-link', { email: runtime.ownerEmail }], ['/api/calls', {}], ['/_server/unknown', {}]]) {
      assert.equal((await post(runtime, path, input, { cookie, origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' })).status, 403, path)
    }
    assert.equal((await runtime.request('/auth/session', { headers: { cookie } })).status, 200, 'forged signout did not revoke')
    assert.deepEqual(await runtime.db.prepare('SELECT COUNT(*) AS n FROM oa_operators').first(), before)
    for (const path of ['/api/carriers/twilio/callback', '/api/carriers/telnyx/callback']) {
      assert.equal((await post(runtime, path, {}, { cookie, 'x-twilio-signature': 'synthetic-handset-8' })).status, 404)
      assert.equal((await post(runtime, path, {})).status, 401)
    }
    for (let attempt = 0; attempt < 30; attempt++) await post(runtime, '/auth/magic-link', { email: 'synthetic-handset-7@example.test' })
    assert.equal((await post(runtime, '/auth/magic-link', { email: 'synthetic-handset-7@example.test' })).status, 429)
    assert.equal(runtime.mails.length, 1, 'throttled or unknown requests sent no mail')
  } finally { await runtime.close() }
})
