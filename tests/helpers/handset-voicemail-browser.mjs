import assert from 'node:assert/strict'
import { mailLink, post, signIn } from './handset-auth.mjs'

export async function voicemailJourney({ runtime, page, context, cookie, proof }) {
 const root = '/app/voicemail', api = '/api/handset/voicemail/boxes', owner = { cookie }
 const read = async (path, headers = owner) => {
  const response = await runtime.request(path, { headers })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
 }
 const write = async (path, input, headers = owner, status = 200) => {
  const response = await post(runtime, path, input, headers)
  assert.equal(response.status, status, await response.clone().text())
  return response.json()
 }
 const authenticate = async (target, session) => {
  const [name, ...value] = session.split('=')
  await target.clearCookies()
  await target.addCookies([{ name, value: value.join('='), url: runtime.origin, secure: true, httpOnly: true, sameSite: 'Lax' }])
 }
 const submit = async (target, name) => {
  await target.getByRole('button', { name, exact: true }).click()
  await target.waitForLoadState('load')
 }
 const reload = async target => {
  await target.getByRole('link', { name: 'Reload mailbox', exact: true }).click()
  await target.waitForLoadState('load')
 }
 const due = async (target, count) => assert.equal(await target.getByText(`${count} due`, { exact: true }).count(), 1)
 const state = async (target, value) => assert.equal(await target.getByText(value, { exact: true }).count(), 1)
 const create = async (name, kind) => {
  await page.goto(runtime.origin + root)
  await page.getByRole('link', { name: 'Mailbox settings', exact: true }).click()
  await proof('voicemail-settings-list')
  await page.getByRole('link', { name: 'New mailbox', exact: true }).click()
  assert.equal(new URL(page.url()).pathname, root + '/settings/new')
  await page.getByLabel('Mailbox name', { exact: true }).fill(name)
  await page.getByLabel('Mailbox kind', { exact: true }).selectOption(kind)
  await proof('voicemail-create-'+kind)
  await submit(page, 'Create mailbox')
  await page.getByRole('heading', { name, exact: true }).waitFor()
  return new URL(page.url()).pathname
 }

 await page.goto(runtime.origin + root)
 await page.getByRole('heading', { name: 'Voicemail', exact: true }).waitFor()
 await proof('voicemail-empty')
 const name = 'Service desk / Atención', boxPath = await create(name, 'shared')
 const boxId = boxPath.split('/').at(-1), boxApi = api + '/' + boxId
 await due(page, 0); await proof('voicemail-mailbox-empty')
 const observations = [
  { sourceId: 'synthetic-handset-voicemail-en', text: 'Please review the supplied service request.', language: 'en' },
  { sourceId: 'synthetic-handset-voicemail-es', text: 'Por favor revise la solicitud de servicio suministrada.', language: 'es' },
 ]
 for (const observation of observations) {
  await page.getByText('Add supplied observation', { exact: true }).click()
  await page.getByLabel('Source reference', { exact: true }).fill(observation.sourceId)
  await page.getByLabel('Observation text', { exact: true }).fill(observation.text)
  await page.getByLabel('Observation language', { exact: true }).selectOption(observation.language)
  await submit(page, 'Add observation')
 }
 let current = await read(boxApi)
 for (const observation of observations) {
  const item = current.items.find(item => item.source_id === observation.sourceId)
  assert.ok(item)
  assert.equal(item.language, observation.language)
  for (const capability of ['captureQualified', 'transcriptionQualified', 'outboundAuthority']) assert.equal(item[capability], false)
  assert.ok((await page.locator('main').innerText()).includes(observation.text))
 }
 assert.match(await page.locator('main').innerText(), /supplied/i)
 assert.match(await page.locator('main').innerText(), /unqualified|not qualified|not established|not verified/i)
 await due(page, 2); await proof('voicemail-supplied-observations')
 const item = current.items.find(item => item.source_id === observations[0].sourceId)
 const itemPath = boxPath + '/items/' + item.id, itemApi = boxApi + '/items/' + item.id
 await page.goto(runtime.origin + root)
 await due(page, 2)
 await proof('voicemail-mailboxes')
 await page.getByRole('link', { name, exact: true }).click()
 assert.equal(new URL(page.url()).pathname, boxPath)
 await page.getByRole('link', { name: 'Open observation', exact: true }).and(page.locator(`a[href="${itemPath}"]`)).click()
 assert.equal(new URL(page.url()).pathname, itemPath)
 await state(page, 'Open'); await proof('voicemail-observation')

 const firstEmail = ['synthetic-handset-2', 'example.test'].join('@'), secondEmail = ['synthetic-handset-voicemail', 'example.test'].join('@')
 await write('/auth/operator/status', { operatorId: 'synthetic-handset-2', status: 'active' })
 const first = { id: 'synthetic-handset-2', name: 'Elliot Brooks', ...(await signIn({ ...runtime, ownerEmail: firstEmail })) }
 await write('/auth/invite', { email: secondEmail, displayName: 'Rosa García', role: 'member' }, owner, 202)
 const invitation = mailLink(runtime.mails.at(-1))
 const accepted = await post(runtime, '/auth/confirm', { token: invitation.searchParams.get('token') })
 assert.equal(accepted.status, 303)
 const person = (await read('/auth/operators')).find(person => person.email === secondEmail)
 assert.equal(person.status, 'active')
 const second = { id: person.id, name: 'Rosa García', cookie: accepted.headers.get('set-cookie').split(';')[0] }
 const groupName = 'Dispatch group / Despacho', groupPath = await create(groupName, 'group')
 const groupApi = api + '/' + groupPath.split('/').at(-1)
 await due(page, 0); await proof('voicemail-group-empty')
 await page.getByText('Add supplied observation', { exact: true }).click()
 await page.getByLabel('Source reference', { exact: true }).fill('synthetic-handset-voicemail-group')
 await page.getByLabel('Observation text', { exact: true }).fill('Supplied group follow-up request.')
 await page.getByLabel('Observation language', { exact: true }).selectOption('en')
 await submit(page, 'Add observation')
 await page.getByRole('link', { name: 'Mailbox settings', exact: true }).click()
 await page.getByLabel('Person reference', { exact: true }).fill(first.id)
 await page.getByLabel('Readership and work', { exact: true }).selectOption('read')
 await submit(page, 'Add or update member')
 assert.match(await page.locator('main').innerText(), /Elliot Brooks · Read only/)
 await proof('voicemail-group-membership-settings')
 await authenticate(context, first.cookie); await page.goto(runtime.origin + groupPath)
 await page.getByRole('link', { name: 'Open observation', exact: true }).click()
 await due(page, 1); await state(page, 'Open')
 const readOnly = await read(groupApi, { cookie: first.cookie })
 assert.equal(readOnly.capabilities.work, false); assert.equal(readOnly.capabilities.assign, false)
 for (const action of ['Claim item', 'Mark handled', 'Reopen item', 'Add note', 'Assign item']) assert.equal(await page.getByRole('button', { name: action, exact: true }).count(), 0)
 await proof('voicemail-group-read-only')
 await authenticate(context, cookie)
 const membership = async (personId, enabled) => {
  const { box } = await read(boxApi)
  await write(boxApi + '/members', { revision: box.revision, personId, enabled, allowWork: 1, allowAssign: 1 })
 }
 await membership(first.id, 1); await membership(second.id, 1)
 const peerContext = await context.browser().newContext({ viewport: page.viewportSize(), ignoreHTTPSErrors: true })
 const peer = await peerContext.newPage(); peer.setDefaultTimeout(10000)
 try {
  await Promise.all([authenticate(context, first.cookie), authenticate(peerContext, second.cookie)])
  await Promise.all([page.goto(runtime.origin + itemPath), peer.goto(runtime.origin + itemPath)])
  const claim = async target => {
   const response = target.waitForResponse(response => response.request().isNavigationRequest() && response.request().method() === 'POST' && new URL(response.url()).pathname === itemPath + '/claim')
   await submit(target, 'Claim item')
   return (await response).status()
  }
  const results = await Promise.all([claim(page), claim(peer)])
  assert.equal(results.filter(status => status >= 200 && status < 400).length, 1, 'exactly one browser claims the item')
  assert.equal(results.filter(status => status === 409).length, 1, 'the concurrent browser sees a revision refusal')
  await Promise.all([reload(page), reload(peer)])
  current = await read(boxApi)
  const claimed = current.items.find(candidate => candidate.id === item.id)
  const winner = [first, second].find(person => person.id === claimed.claimant)
  assert.ok(winner)
  assert.equal(current.history.filter(event => event.item_id === item.id && event.action === 'claim').length, 1)
  for (const target of [page, peer]) {
   const text = await target.locator('main').innerText()
   assert.ok(text.includes(winner.id) || text.includes(winner.name), 'both browsers see the same claimant')
   await state(target, 'Open'); await due(target, 2)
  }
  await proof('voicemail-concurrent-claim-reloaded')
  await page.getByText('Add a note', { exact: true }).click()
  await page.getByLabel('Note', { exact: true }).fill('Please coordinate the supplied service request.')
  await submit(page, 'Add note')
  assert.ok((await page.locator('main').innerText()).includes('Please coordinate the supplied service request.'))
  await page.getByText('Assignment', { exact: true }).click()
  await page.getByLabel('Assign to', { exact: true }).selectOption(second.id)
  await submit(page, 'Assign item')
  assert.equal((await read(boxApi)).items.find(candidate => candidate.id === item.id).claimant, second.id)
  await proof('voicemail-note-and-assignment')
  await authenticate(context, cookie); await page.goto(runtime.origin + itemPath)
  await submit(page, 'Mark handled'); await state(page, 'Handled'); await due(page, 1)
  await Promise.all([reload(page), reload(peer)])
  for (const target of [page, peer]) { await state(target, 'Handled'); await due(target, 1) }
  await proof('voicemail-handled')
  for (const target of [page, peer]) {
   await target.goto(runtime.origin + boxPath)
   const dueList = target.locator('section').filter({ has: target.getByRole('heading', { name: 'Due observations', exact: true }) })
   assert.equal((await dueList.innerText()).includes(observations[0].text), false)
   assert.ok((await dueList.innerText()).includes(observations[1].text))
   await target.getByText('Handled observations', { exact: true }).click()
   assert.equal(await target.locator(`a[href="${itemPath}"]`).count(), 1, 'handled observation remains retrievable')
  }
  await proof('voicemail-cleared-due-list')
  await Promise.all([page.goto(runtime.origin + itemPath), peer.goto(runtime.origin + itemPath)])
  await submit(page, 'Reopen item'); await state(page, 'Open'); await due(page, 2)
  await Promise.all([reload(page), reload(peer)])
  for (const target of [page, peer]) { await state(target, 'Open'); await due(target, 2) }
  current = await read(boxApi)
  assert.equal(current.items.find(candidate => candidate.id === item.id).claimant, null)
  for (const action of ['claim', 'note', 'assign', 'handle', 'reopen']) assert.ok(current.history.some(event => event.item_id === item.id && event.action === action), action + ' remains in history')
  assert.match(await page.locator('main').innerText(), /history/i)
  await proof('voicemail-reopened-history')

  const draft = 'This stale note must remain available for review.'
  await page.getByText('Add a note', { exact: true }).click()
  await page.getByLabel('Note', { exact: true }).fill(draft)
  const latest = current.items.find(candidate => candidate.id === item.id)
  await write(itemApi + '/note', { revision: latest.revision, note: 'A colleague updated the current observation.' }, { cookie: second.cookie })
  const staleResponse = page.waitForResponse(response => response.request().isNavigationRequest() && response.request().method() === 'POST' && new URL(response.url()).pathname === itemPath + '/note')
  await submit(page, 'Add note'); assert.equal((await staleResponse).status(), 409)
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByLabel('Note', { exact: true }).inputValue(), draft)
  assert.equal((await read(boxApi)).history.some(event => event.note === draft), false)
  await proof('voicemail-stale-note-retained')
  await page.getByRole('checkbox', { name: 'I compared my draft with the current history', exact: true }).check()
  await submit(page, 'Add note')
  assert.equal((await read(boxApi)).history.filter(event => event.note === draft).length, 1)
  await reload(page)

  await authenticate(context, first.cookie)
  await page.goto(runtime.origin + root + '/settings/new')
  assert.deepEqual(await page.getByLabel('Mailbox kind', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value)), ['personal'])
  const privatePath = await create('Elliot private supplied observations', 'personal')
  await due(page, 0)
  await authenticate(context, cookie)
  assert.equal((await page.goto(runtime.origin + privatePath)).status(), 403)
  await page.getByRole('heading', { name: 'Mailbox unavailable', exact: true }).waitFor()
  await page.getByRole('alert').waitFor()
  assert.equal((await page.locator('main').innerText()).includes('Elliot private supplied observations'), false)
  await proof('voicemail-personal-refused')
  await page.goto(runtime.origin + root)
  assert.equal(await page.getByRole('link', { name: 'Elliot private supplied observations', exact: true }).count(), 0)

  await authenticate(context, first.cookie); await page.goto(runtime.origin + itemPath)
  await page.getByText('Add a note', { exact: true }).click()
  await page.getByLabel('Note', { exact: true }).fill('Withdrawn draft must not be shown.')
  await membership(first.id, 0)
  const withdrawnResponse = page.waitForResponse(response => response.request().isNavigationRequest() && response.request().method() === 'POST' && new URL(response.url()).pathname === itemPath + '/note')
  await submit(page, 'Add note'); assert.equal((await withdrawnResponse).status(), 403)
  await page.getByRole('heading', { name: 'Mailbox unavailable', exact: true }).waitFor()
  await page.getByRole('alert').waitFor()
  const deniedText = await page.locator('main').innerText()
  for (const privateText of [name, observations[0].text, observations[1].text, 'Withdrawn draft must not be shown.']) assert.equal(deniedText.includes(privateText), false)
  assert.equal(await page.getByLabel('Note', { exact: true }).count(), 0)
  assert.equal((await read(boxApi)).history.some(event => event.note === 'Withdrawn draft must not be shown.'), false)
  assert.equal((await page.goto(runtime.origin + boxPath)).status(), 403)
  await proof('voicemail-withdrawn-membership')
  await page.goto(runtime.origin + root)
  assert.equal(await page.getByRole('link', { name, exact: true }).count(), 0)

  await authenticate(context, cookie)
  await runtime.sql("CREATE TRIGGER synthetic_browser_voicemail_failure BEFORE INSERT ON hnd_actor_refs WHEN NEW.operator_id='synthetic-handset-1' BEGIN SELECT RAISE(ABORT,'synthetic_voicemail_read_failure'); END")
  try {
   assert.equal((await page.goto(runtime.origin + boxPath)).status(), 503)
   await page.getByRole('heading', { name: 'Mailbox unavailable', exact: true }).waitFor()
   assert.match(await page.getByRole('alert').innerText(), /could not be loaded/i)
   assert.equal((await page.locator('main').innerText()).includes(observations[0].text), false)
   await proof('voicemail-load-failed')
  } finally { await runtime.sql('DROP TRIGGER synthetic_browser_voicemail_failure') }
  await reload(page); await due(page, 2); await proof('voicemail-load-recovered')
  assert.deepEqual(runtime.sourceRequests, [], 'supplied observations never establish provider capture or outbound activity')
 } finally { await peerContext.close(); await authenticate(context, cookie) }
}
