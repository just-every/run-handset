import assert from 'node:assert/strict'

export const privateReads = ['/auth/session', '/auth/operators', '/auth/sessions', '/auth/domain-rules', '/auth/providers', '/auth/settings/identity', '/api', '/api/calls', '/media/recording.wav', '/_server/unknown']
export const privateDocuments = ['/app', '/app/calls', '/app/recording.wav', '/setup']
export const privateWrites = [
  ['/auth/invite', { email: 'synthetic-handset-5@example.test', displayName: 'Mara Patel', role: 'member' }],
  ['/auth/invite/cancel', { operatorId: 'synthetic-handset-2' }],
  ['/auth/operator/status', { operatorId: 'synthetic-handset-2', status: 'active' }],
  ['/auth/operator/role', { operatorId: 'synthetic-handset-2', role: 'member' }],
  ['/auth/domain-rules', { domain: 'example.test', provider: null }],
  ['/auth/providers/unlink', { provider: 'synthetic-handset-6' }],
  ['/auth/providers/relink', { provider: 'synthetic-handset-6' }],
  ['/auth/settings/identity', { idpSignIn: true }],
  ['/auth/email', { email: 'synthetic-handset-5@example.test' }],
  ['/auth/display-name', { displayName: 'Mara Patel' }],
  ['/auth/step-up', { action: 'export' }],
]
export const post = (runtime, path, input, headers = {}) => runtime.request(path, {
  method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(input),
})
export function mailLink(message) {
  const text = message.content.find(part => part.type === 'text/plain').value
  const link = text.match(/https:\/\/[^\s]+\/auth\/confirm\?token=[A-Za-z0-9_-]+/)
  assert.ok(link, 'the actual mail contains a native confirmation link')
  return new URL(link[0])
}
export async function signIn(runtime) {
  assert.equal((await post(runtime, '/auth/magic-link', { email: runtime.ownerEmail, returnTo: '/app' })).status, 202)
  const link = mailLink(runtime.mails.at(-1))
  const response = await post(runtime, '/auth/confirm', { token: link.searchParams.get('token') })
  assert.equal(response.status, 303)
  return { cookie: response.headers.get('set-cookie').split(';')[0], response, link }
}
export async function deniedPrivateDoors(runtime, cookie) {
  const headers = cookie ? { cookie } : {}
  for (const path of privateReads) {
    const response = await runtime.request(path, { headers })
    assert.equal(response.status, 401, path)
    assert.ok(!(await response.text()).includes(runtime.ownerEmail), path)
  }
  for (const path of privateDocuments) {
    const response = await runtime.request(path, { headers })
    assert.equal(response.status, 303, path)
    assert.ok(response.headers.get('location').startsWith('/signin'), path)
    assert.equal(await response.text(), '')
  }
  for (const [path, input] of privateWrites) assert.equal((await post(runtime, path, input, headers)).status, 401, path)
  for (const path of ['/api/calls', '/media/recording.wav', '/_server/unknown', '/app/calls']) {
    assert.equal((await post(runtime, path, {}, headers)).status, 401, path)
  }
  assert.equal((await runtime.request('/setup', { method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: 'confirm=yes' })).status, 401)
}
