import assert from 'node:assert/strict'
import { post, signIn } from './handset-auth.mjs'
import { sourceFixture } from './handset-sources.mjs'
import { localDateTime } from './handset-browser-time.mjs'

export async function complianceJourney({ runtime, page, context, cookie, proof: captureProof }) {
 const root = '/app/compliance', api = '/api/handset/compliance', headers = { cookie }
 const dueAt = Math.floor((Date.now() - 3600000) / 60000) * 60000
 const source = await sourceFixture(runtime), cases = new Map()
 const proof = async name => {
  assert.equal(await page.locator('main button, main a, main summary').evaluateAll(controls => controls.filter(c => c.getClientRects().length).every(c => c.textContent.trim())), true, 'visible controls have text labels')
  assert.equal(await page.locator('main input:not([type="hidden"]), main textarea, main select').evaluateAll(fields => fields.filter(f => f.getClientRects().length).every(f => f.labels?.length || f.getAttribute('aria-label'))), true, 'visible fields have accessible labels')
  assert.equal(await page.locator('main p, main li, main dt, main dd, main label, main button, main a, main summary, main input:not([type="hidden"]), main textarea, main select').evaluateAll(elements => elements.filter(el => el.getClientRects().length).every(el => parseFloat(getComputedStyle(el).fontSize) >= 13)), true, 'visible text and form controls remain readable')
  await captureProof(name)
 }
 const read = async path => {
  const response = await runtime.request(api + path, { headers })
  assert.equal(response.status, 200)
  return response.json()
 }
 const form = (id, action) => page.locator(`form[action="${root}/${id}/${action}"]`)
 const reveal = async scope => {
  const disclosures = scope.locator('xpath=ancestor::details')
  for (let i = 0; i < await disclosures.count(); i++) {
   const disclosure = disclosures.nth(i)
   if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click()
  }
 }
 const confirm = async scope => { await reveal(scope); await scope.getByRole('checkbox').check() }
 const fill = async (scope, fields) => {
  await reveal(scope)
  for (const [label, value] of Object.entries(fields)) await scope.getByLabel(label, { exact: true }).fill(String(value))
 }
 const submit = async (scope, name, expectedStatus) => {
  await reveal(scope)
  const action = await scope.getAttribute('action')
  const received = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === action)
  await scope.getByRole('button', { name, exact: true }).click()
  const response = await received
  await page.waitForLoadState('load')
  if (expectedStatus !== undefined) assert.equal(response.status(), expectedStatus)
  else assert.ok(response.status() < 400, name + ' accepted through the native form')
 }
 const authenticate = async value => {
  const [name, ...parts] = value.split('=')
  await context.clearCookies()
  await context.addCookies([{ name, value: parts.join('='), url: runtime.origin, secure: true, httpOnly: true, sameSite: 'Lax' }])
 }
 const record = async (kind, n, data) => {
  const response = await post(runtime, '/api/handset/records', { kind, sourceId: 'synthetic-handset-' + n, occurredAt: Date.now(), data }, headers)
  assert.equal(response.status, 201)
  return (await response.json()).record
 }
 const endpoint = await record('endpoint', 7751, { name: 'Rosa office phone', platform: 'desktop' })
 const location = await record('location', 7752, { name: 'Austin second floor', timezone: 'America/Chicago' })
 const notice = await record('comment', 7753, { text: 'Authorized employee reported a move; carrier and location confirmation remain pending' })
 const observations = [
  ['port_pin', { 'Port request ID': 'synthetic-handset-7761', 'Port phone resource ID': 'synthetic-handset-7762' }],
  ['e911_move', { 'Endpoint record ID': endpoint.id, 'Location record ID': location.id, 'Move notice record ID': notice.id }],
  ['brand_registration', { 'Receipt ID': 'synthetic-handset-7763', 'Reported status': 'FAILED', 'Rejection reason': 'Business facts need representative review' }],
  ['tollfree_verification', { 'Receipt ID': 'synthetic-handset-7764', 'Reported status': 'TWILIO_REJECTED', 'Rejection reason': 'Named representative attestation required', 'Rejection code': '30442' }],
  ['reputation', { 'Receiving network': 'Controlled receiving network A', 'Observed at (UTC)': localDateTime(dueAt), 'Observed label': 'spam', 'Evidence record ID': notice.id }],
 ]

 await page.goto(runtime.origin + root)
 assert.equal((await read('')).cases.length, 0)
 assert.equal(await page.locator(`a[href^="${root}/"]`).evaluateAll(links => links.some(link => /\/[0-9a-f-]{36}$/.test(new URL(link.href).pathname))), false)
 await proof('compliance-empty')
 for (const [kind, fields] of observations) {
  const response = await page.goto(runtime.origin + root + '/new?kind=' + kind)
  assert.equal(response.status(), 200, await page.locator('main').innerText())
  const editor = page.locator('form').filter({ has: page.getByRole('button', { name: 'Prepare correction', exact: true }) })
  assert.equal(await editor.getByLabel('Business number', { exact: true }).count(), 1, await page.locator('main').ariaSnapshot())
  await editor.getByLabel('Business number', { exact: true }).selectOption(source.source.id)
  await fill(editor, { 'Due at (UTC)': localDateTime(dueAt), ...fields })
  await confirm(editor)
  await proof('compliance-prepare-' + kind)
  await submit(editor, 'Prepare correction')
  const id = new URL(page.url()).pathname.split('/').at(-1), detail = await read('/' + id), row = detail.case
  assert.equal(row.kind, kind); assert.equal(row.source_id, source.source.id); assert.equal(row.number_id, source.numberId)
  assert.equal(row.owner_id, 'synthetic-handset-1'); assert.equal(row.due_at, dueAt); assert.equal(row.status, 'prepared')
  assert.equal(detail.cleanCompliance, false); assert.equal(detail.cleanReputation, false)
  const reported = Object.values(JSON.parse(row.report)).map(String)
  for (const [label, value] of Object.entries(fields)) assert.ok(reported.includes(String(label === 'Observed at (UTC)' ? dueAt : value)), 'typed observation is retained in the exact native report')
  await page.getByText('Exact source and reported observation', { exact: true }).click()
  const text = await page.locator('main').innerText()
  for (const value of [row.plan, row.id, source.account, '+15125550125', 'Mara Patel']) assert.ok(text.includes(value), 'detail exposes correction and accountable exact source')
  assert.equal(await page.locator('input[type="password"], input[name*="pin" i]').count(), 0, 'preparation never requests a raw PIN')
  cases.set(kind, row)
  await proof('compliance-prepared-' + kind)
 }
 await page.goto(runtime.origin + root)
 const populated = (await read('')).cases
 assert.equal(populated.length, observations.length)
 for (const row of populated) assert.equal(await page.locator(`a[href="${root}/${row.id}"]`).count() > 0, true)
 await proof('compliance-populated')

 const port = cases.get('port_pin'), correction = 'Request the PIN privately and have the named representative sign the exact-number LOA.'
 await page.goto(runtime.origin + root + '/' + port.id)
 await fill(form(port.id, 'review'), { 'Prepared corrections': correction })
 await confirm(form(port.id, 'review'))
 await submit(form(port.id, 'review'), 'Record preparation review')
 let current = (await read('/' + port.id)).case
 assert.equal(current.approval_note, correction); assert.equal(current.status, 'reviewed')
 await proof('compliance-reviewed-preparation')

 const nextAction = 'Follow the receiving carrier case with Rosa; retain service and request the signed exact-number LOA.'
 const follow = () => form(port.id, 'follow-up'), future = Math.floor((Date.now() + 86400000) / 60000) * 60000
 await reveal(follow())
 await follow().getByLabel('Named owner', { exact: true }).selectOption('synthetic-handset-1')
 await fill(follow(), { 'Due at (UTC)': localDateTime(dueAt), 'Next action': nextAction })
 await confirm(follow())
 await submit(follow(), 'Assign continued follow-up', 400)
 await page.getByRole('alert').waitFor()
 assert.equal(await follow().getByLabel('Next action', { exact: true }).inputValue(), nextAction)
 assert.equal(await follow().getByLabel('Due at (UTC)', { exact: true }).inputValue(), localDateTime(dueAt))
 assert.equal((await read('/' + port.id)).case.revision, current.revision)
 await proof('compliance-validation-retains-correction')
 await fill(follow(), { 'Due at (UTC)': localDateTime(future) })
 await confirm(follow())
 const competing = await post(runtime, api + '/' + port.id + '/review', { revision: current.revision, note: 'Carrier case checked separately; follow-up still required', confirm: 'review exact correction preparation' }, headers)
 assert.equal(competing.status, 200)
 await submit(follow(), 'Assign continued follow-up', 409)
 await page.getByRole('alert').waitFor()
 assert.equal(await follow().getByLabel('Next action', { exact: true }).inputValue(), nextAction)
 assert.equal(await follow().getByLabel('Due at (UTC)', { exact: true }).inputValue(), localDateTime(future))
 assert.equal(await follow().getByRole('checkbox').isChecked(), false, 'stale correction requires a fresh explicit confirmation')
 await proof('compliance-stale-retains-correction')
 await confirm(follow())
 await submit(follow(), 'Assign continued follow-up')
 const followed = await read('/' + port.id)
 assert.equal(followed.case.due_at, future); assert.equal(followed.case.owner_id, 'synthetic-handset-1')
 const history = followed.events.find(e => e.kind === 'follow_up')
 assert.ok(history); assert.equal(JSON.parse(history.evidence).nextAction, nextAction)
 assert.equal(JSON.parse(history.evidence).previousDueAt, dueAt)
 await page.getByText('Review history', { exact: true }).click()
 assert.ok((await page.locator('main').innerText()).includes(nextAction))
 await proof('compliance-continued-follow-up')

 await confirm(form(port.id, 'readback'))
 await submit(form(port.id, 'readback'), 'Read exact provider receipt', 503)
 await page.getByRole('alert').waitFor()
 assert.equal((await read('/' + port.id)).case.due_at, future)
 await proof('compliance-readback-unavailable')
 const privatePin = 'synthetic-handset-7771', privateBusiness = 'synthetic-handset-7772'
 const receipts = [
  ['port_pin', 'https://numbers.twilio.com/v1/Porting/PortIn/synthetic-handset-7761/PhoneNumber/synthetic-handset-7762', { port_in_request_sid: 'synthetic-handset-7761', phone_number_sid: 'synthetic-handset-7762', account_sid: source.account, phone_number: '+15125550125', port_in_phone_number_status: 'port_pending', port_date: '2026-11-02T18:00:00Z', port_out_pin: privatePin }, 'port_pending'],
  ['brand_registration', 'https://messaging.twilio.com/v1/a2p/BrandRegistrations/synthetic-handset-7763', { sid: 'synthetic-handset-7763', account_sid: source.account, status: 'APPROVED', customer_profile_bundle_sid: privatePin }, 'APPROVED'],
  ['tollfree_verification', 'https://messaging.twilio.com/v1/Tollfree/Verifications/synthetic-handset-7764', { sid: 'synthetic-handset-7764', account_sid: source.account, tollfree_phone_number: '+15125550125', status: 'TWILIO_APPROVED', business_contact_email: privateBusiness }, 'TWILIO_APPROVED'],
 ]
 for (const [kind, url, receipt, state] of receipts) {
  const row = cases.get(kind)
  runtime.twilioResources.set(url, receipt)
  await page.goto(runtime.origin + root + '/' + row.id)
  await confirm(form(row.id, 'readback'))
  await submit(form(row.id, 'readback'), 'Read exact provider receipt')
  const detail = await read('/' + row.id), safe = JSON.parse(detail.case.readback)
  assert.equal(detail.case.provider_state, state); assert.equal(detail.case.status, 'follow_up')
  assert.equal(detail.case.due_at, kind === 'port_pin' ? future : dueAt)
  assert.equal(safe.voiceReady, 'unproved'); assert.equal(safe.smsReady, 'unproved'); assert.equal(safe.reputation, 'unknown')
  assert.equal(detail.cleanCompliance, false); assert.equal(detail.cleanReputation, false)
  const html = await page.content()
  for (const secret of [privatePin, privateBusiness]) {
   assert.equal(html.includes(secret), false, 'provider private fields never enter the document')
   assert.equal(JSON.stringify(detail).includes(secret), false, 'provider private fields never enter retained case and history')
  }
  assert.ok((await page.locator('main').innerText()).includes(state))
  await proof('compliance-readback-' + kind)
 }
 for (const [kind, row] of cases) {
  await page.goto(runtime.origin + root + '/' + row.id)
  const before = (await read('/' + row.id)).case
  await submit(form(row.id, 'submit'), 'Check submission hold')
  const held = await read('/' + row.id)
  assert.equal(held.case.revision, before.revision); assert.equal(held.case.due_at, before.due_at)
  assert.ok(held.events.some(e => e.kind === 'held'))
  await page.getByRole('status').filter({ hasText: /required|pending/i }).last().waitFor()
  if (kind === 'port_pin') await proof('compliance-submission-held')
  if (kind === 'e911_move' || kind === 'reputation') {
   await confirm(form(row.id, 'readback'))
   await submit(form(row.id, 'readback'), 'Read exact provider receipt')
   assert.equal((await read('/' + row.id)).case.provider_state, 'unknown')
   await proof('compliance-readback-held-' + kind)
  }
 }
 await runtime.restart()
 await page.goto(runtime.origin + root)
 const retained = (await read('')).cases
 assert.equal(retained.length, cases.size)
 assert.ok(retained.every(row => row.owner_id === 'synthetic-handset-1' && row.due_at === (row.id === port.id ? future : dueAt)))
 await proof('compliance-unresolved-after-restart')
 assert.ok(runtime.sourceRequests.length > 0)
 assert.ok(runtime.sourceRequests.every(r => r.method === 'GET'), 'preparation, review, follow-up and holds never mutate a carrier, number or active emergency location')

 assert.equal((await post(runtime, '/auth/operator/status', { operatorId: 'synthetic-handset-2', status: 'active' }, headers)).status, 200)
 const member = await signIn({ ...runtime, ownerEmail: runtime.ownerEmail.replace('synthetic-handset-1', 'synthetic-handset-2') })
 await authenticate(member.cookie)
 const denied = await page.goto(runtime.origin + root + '/' + port.id)
 assert.equal(denied.status(), 403); await page.getByRole('alert').waitFor()
 assert.equal((await page.locator('main').innerText()).includes(correction), false)
 await proof('compliance-detail-denied')
 for (const action of ['review', 'follow-up', 'readback', 'submit']) assert.equal((await post(runtime, api + '/' + port.id + '/' + action, { revision: (await read('/' + port.id)).case.revision }, { cookie: member.cookie })).status, 403)
 await context.clearCookies()
 for (const path of [root, root + '/' + port.id]) {
  await page.goto(runtime.origin + path)
  assert.match(new URL(page.url()).pathname, /signin/)
 }
 await authenticate(cookie)
}
