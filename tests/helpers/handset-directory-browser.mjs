import assert from 'node:assert/strict'
import { post, signIn } from './handset-auth.mjs'

export async function directoryJourney({ runtime, page, context, cookie, proof: captureProof, click }) {
 const root = '/app/directory', api = '/api/handset/directory', memberId = 'synthetic-handset-2'
 const headers = { cookie }, sourceRequests = runtime.sourceRequests.length
 const permissions = (await runtime.sql('SELECT * FROM hnd_text_permissions')).results
 const phoneLabel = 'Phone number with calling code and optional extension', zoneLabel = 'Timezone (leave empty if unknown)'
 const keeperSource = 'synthetic-handset-7811', otherSource = 'synthetic-handset-7812'
 const proof = async name => {
  assert.equal(await page.locator('main button, main a, main summary').evaluateAll(items => items.filter(el => el.getClientRects().length).every(el => el.textContent.trim())), true, 'visible controls have text labels')
  assert.equal(await page.locator('main input:not([type="hidden"]), main textarea, main select').evaluateAll(items => items.filter(el => el.getClientRects().length).every(el => el.labels?.length || el.getAttribute('aria-label'))), true, 'visible fields have accessible labels')
  assert.equal(await page.locator('main p, main li, main span, main dt, main dd, main label, main button, main a, main summary, main input:not([type="hidden"]), main textarea, main select').evaluateAll(items => items.filter(el => el.getClientRects().length).every(el => parseFloat(getComputedStyle(el).fontSize) >= 13)), true, 'visible text and fields remain readable')
  await captureProof(name)
 }
 const authenticate = async value => {
  const [name, ...parts] = value.split('=')
  await context.clearCookies()
  await context.addCookies([{ name, value: parts.join('='), url: runtime.origin, secure: true, httpOnly: true, sameSite: 'Lax' }])
 }
 const read = async (suffix = '', auth = headers) => {
  const response = await runtime.request(api + suffix, { headers: auth })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
 }
 const contact = async id => (await read('/contacts/' + id)).contact
 const write = async (suffix, value) => {
  const response = await post(runtime, api + '/contacts/' + suffix, value, headers)
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
 }
 const grant = async (id, capabilities = {}) => write(id + '/grant', { revision: (await contact(id)).revision, personId: memberId, ...capabilities })
 const form = (id, action) => page.locator(`form[method="post"][action="${root}/${id}/${action}"]`)
 const submit = async (scope, name, status = 303) => {
  const action = await scope.getAttribute('action')
  const received = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === action)
  await scope.getByRole('button', { name, exact: true }).click()
  assert.equal((await received).status(), status)
  await page.waitForLoadState('load')
 }
 const openActions = async () => page.getByText('Edit or merge contact', { exact: true }).click()
 const facts = async values => {
  const text = await page.locator('main').innerText()
  for (const value of values) assert.ok(text.includes(value), 'current contact fact is visible: ' + value)
 }
 const noDetails = async values => {
  const html = await page.content()
  for (const value of values) assert.equal(html.includes(value), false, 'refused response omits private contact values')
 }
 const create = async ({ name, number, visibility = 'personal', sources = [], timezone = '', suppressed = false, held = false }, label) => {
  await page.goto(runtime.origin + root)
  const disclosure = page.locator('details').filter({ has: page.getByText('Create contact', { exact: true }) })
  if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click()
  await page.getByRole('link', { name: 'New contact', exact: true }).click()
  const editor = page.locator(`form[action="${root}/new"]`)
  await editor.getByLabel('Name', { exact: true }).fill(name)
  await editor.getByLabel(phoneLabel, { exact: true }).fill(number)
  await editor.getByLabel(zoneLabel, { exact: true }).fill(timezone)
  await editor.getByLabel('Visibility', { exact: true }).selectOption(visibility)
  await editor.getByLabel('Source IDs (one per line)', { exact: true }).fill(sources.join('\n'))
  await editor.getByLabel('Keep this contact suppressed', { exact: true }).setChecked(suppressed)
  await editor.getByLabel('Keep this contact on hold', { exact: true }).setChecked(held)
  await proof('directory-create-' + label)
  await submit(editor, 'Create contact')
  const id = new URL(page.url()).pathname.split('/').at(-1)
  await facts([name, visibility === 'personal' ? 'Personal · unshared' : 'Company'])
  return id
 }
 const openMerge = async (keeperId, otherId) => {
  await page.goto(runtime.origin + root + '/' + keeperId)
  await openActions()
  await page.getByRole('link', { name: 'Review an explicit merge', exact: true }).click()
  await page.getByLabel('Other company contact', { exact: true }).selectOption(otherId)
  await click('Review selected contacts')
 }

 await page.goto(runtime.origin + root)
 assert.deepEqual((await read()).contacts, [])
 assert.equal(await page.locator('main .hs-rows a').count(), 0)
 await proof('directory-empty')
 const privateName = 'Mara’s private mechanic', memberName = 'Rosa’s private dentist'
 const personal = await create({ name: privateName, number: '+15125550192', sources: ['synthetic-handset-7813'] }, 'personal')
 await page.getByText('Source identities', { exact: true }).click()
 await facts(['Timezone unknown', 'synthetic-handset-7813'])
 await proof('directory-private-detail')
 const keeper = await create({ name: 'Harbor Clinic', number: '+15125550191 x42', visibility: 'company', sources: [keeperSource], suppressed: true }, 'company-keeper')
 const other = await create({ name: 'Harbor Clinic reception', number: '+442079460123', visibility: 'company', timezone: 'Europe/London', sources: [otherSource], held: true }, 'company-held')
 await page.getByText('Source identities', { exact: true }).click()
 await facts(['Europe/London', 'Held', otherSource])
 await proof('directory-held-detail')
 await page.goto(runtime.origin + root)
 await facts([privateName, 'Harbor Clinic', '+15125550191 ext 42', 'Timezone unknown'])
 await proof('directory-owner-list')

 assert.equal((await post(runtime, '/auth/operator/status', { operatorId: memberId, status: 'active' }, headers)).status, 200)
 const member = await signIn({ ...runtime, ownerEmail: runtime.ownerEmail.replace('synthetic-handset-1', memberId) })
 const memberHeaders = { cookie: member.cookie }
 await authenticate(member.cookie)
 await page.goto(runtime.origin + root)
 assert.deepEqual((await read('', memberHeaders)).contacts, [])
 await noDetails([privateName, 'Harbor Clinic', keeperSource, otherSource])
 await proof('directory-unshared-member-empty')
 assert.equal((await page.goto(runtime.origin + root + '/' + personal)).status(), 403)
 await noDetails([privateName, 'synthetic-handset-7813'])
 await proof('directory-private-member-refused')
 const memberPersonal = await create({ name: memberName, number: '+15125550193', sources: ['synthetic-handset-7814'] }, 'member-personal')
 assert.equal((await read('/contacts/' + memberPersonal, memberHeaders)).contact.owner_id, memberId)
 await authenticate(cookie)
 assert.equal((await page.goto(runtime.origin + root + '/' + memberPersonal)).status(), 403)
 await noDetails([memberName, 'synthetic-handset-7814'])
 await proof('directory-member-private-owner-refused')
 assert.equal((await post(runtime, api + '/contacts/' + personal + '/grant', { revision: (await contact(personal)).revision, personId: memberId }, headers)).status, 403)

 await grant(keeper)
 await grant(other)
 await authenticate(member.cookie)
 await page.goto(runtime.origin + root)
 await facts([memberName, 'Harbor Clinic'])
 await noDetails([privateName])
 await proof('directory-explicitly-shared-list')
 await page.getByRole('link').filter({ hasText: 'Harbor Clinic' }).filter({ hasText: '+15125550191' }).click()
 await page.getByText('Source identities', { exact: true }).click()
 await facts([keeperSource, 'Timezone unknown', 'Suppressed', '+15125550191 ext 42'])
 assert.equal(await page.locator(`a[href="${root}/${keeper}/edit"], a[href="${root}/${keeper}/merge"]`).count(), 0)
 await proof('directory-shared-read-only-detail')
 const beforeDenied = await contact(keeper), second = await contact(other)
 for (const action of ['edit', 'merge']) {
  assert.equal((await page.goto(runtime.origin + root + '/' + keeper + '/' + action)).status(), 403)
  const value = action === 'edit' ? { revision: beforeDenied.revision, name: 'Unapproved change', number: beforeDenied.number, timezone: '' } : { revision: beforeDenied.revision, otherId: other, otherRevision: second.revision, confirm: 'merge these exact contacts and withdraw read grants' }
  const refused = await runtime.request(root + '/' + keeper + '/' + action, { method: 'POST', headers: { ...memberHeaders, origin: runtime.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(value).toString() })
  assert.equal(refused.status, 403)
  assert.equal((await refused.text()).includes(beforeDenied.name), false)
  assert.equal((await post(runtime, api + '/contacts/' + keeper + (action === 'merge' ? '/merge' : ''), value, memberHeaders)).status, 403)
 }
 assert.deepEqual(await contact(keeper), beforeDenied)
 assert.deepEqual(await contact(other), second)
 assert.equal((await read('/export', memberHeaders)).contacts.some(row => row.id === keeper || row.id === other), false)
 await noDetails([beforeDenied.name, keeperSource, otherSource])
 await proof('directory-capabilities-refused')

 await grant(keeper, { allowEdit: 1 })
 await page.goto(runtime.origin + root + '/' + keeper)
 await openActions()
 await page.getByRole('link', { name: 'Edit contact', exact: true }).click()
 await form(keeper, 'edit').getByLabel('Name', { exact: true }).fill('Harbor Clinic appointments')
 await proof('directory-member-edit')
 await submit(form(keeper, 'edit'), 'Save contact changes')
 assert.equal(new URL(page.url()).pathname, root)
 assert.match(await page.locator('main').innerText(), /grants were withdrawn/i)
 assert.equal((await contact(keeper)).name, 'Harbor Clinic appointments')
 assert.equal((await runtime.request(api + '/contacts/' + keeper, { headers: memberHeaders })).status, 403)
 await proof('directory-edit-withdraws-sharing')
 assert.equal((await page.goto(runtime.origin + root + '/' + keeper)).status(), 403)
 await noDetails(['Harbor Clinic appointments', keeperSource])
 await proof('directory-edit-withdrawn-detail')

 // Keep a real loaded detail and edit form while the owner withdraws authority.
 await grant(keeper, { allowEdit: 1 })
 await page.goto(runtime.origin + root + '/' + keeper)
 const cachedEdit = await context.newPage()
 try {
  await cachedEdit.goto(runtime.origin + root + '/' + keeper + '/edit')
  const draft = 'Private cached draft from Rosa'
  await cachedEdit.getByLabel('Name', { exact: true }).fill(draft)
  const beforeRevoke = await contact(keeper)
  await write(keeper + '/revoke', { revision: beforeRevoke.revision, personId: memberId })
  assert.equal((await page.reload()).status(), 403)
  await noDetails([beforeRevoke.name, keeperSource, beforeRevoke.number])
  await proof('directory-revoked-cached-detail')
  const received = cachedEdit.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === root + '/' + keeper + '/edit')
  await cachedEdit.getByRole('button', { name: 'Save contact changes', exact: true }).click()
  assert.equal((await received).status(), 403)
  await cachedEdit.waitForLoadState('load')
  const html = await cachedEdit.content()
  for (const value of [draft, beforeRevoke.name, keeperSource]) assert.equal(html.includes(value), false)
  assert.deepEqual(await contact(keeper), beforeRevoke)
  await page.goto(cachedEdit.url())
  await proof('directory-revoked-cached-edit')
 } finally { await cachedEdit.close() }

 await authenticate(cookie)
 await page.goto(runtime.origin + root + '/' + keeper + '/edit')
 const staleRevision = (await contact(keeper)).revision
 await form(keeper, 'edit').getByLabel('Name', { exact: true }).fill('Harbor Clinic')
 await proof('directory-owner-edit')
 await write(keeper, { revision: staleRevision, name: 'Harbor Clinic billing' })
 await submit(form(keeper, 'edit'), 'Save contact changes', 409)
 await facts(['Harbor Clinic billing'])
 assert.equal(await form(keeper, 'edit').getByLabel('Name', { exact: true }).inputValue(), 'Harbor Clinic')
 const reconcile = form(keeper, 'edit').getByRole('checkbox')
 assert.equal(await reconcile.isChecked(), false)
 assert.equal(await reconcile.getAttribute('required'), '')
 assert.equal(await form(keeper, 'edit').locator('[name="revision"]').inputValue(), String(staleRevision))
 assert.equal(await form(keeper, 'edit').locator('[name="freshRevision"]').inputValue(), String((await contact(keeper)).revision))
 await proof('directory-stale-edit-retains-draft')
 await reconcile.check()
 await submit(form(keeper, 'edit'), 'Apply reviewed changes')
 assert.equal((await contact(keeper)).name, 'Harbor Clinic')
 await proof('directory-reviewed-edit-applied')

 await openMerge(keeper, other)
 const mergeKeeper = await contact(keeper), mergeOther = await contact(other)
 assert.equal(await form(keeper, 'merge').locator('[name="revision"]').inputValue(), String(mergeKeeper.revision))
 assert.equal(await form(keeper, 'merge').locator('[name="otherRevision"]').inputValue(), String(mergeOther.revision))
 await facts([keeperSource, otherSource, 'Timezone unknown', 'Suppressed', 'Held'])
 await form(keeper, 'merge').getByRole('checkbox').check()
 await proof('directory-merge-review')
 await write(other, { revision: mergeOther.revision, name: 'Harbor Clinic reception · verified' })
 await submit(form(keeper, 'merge'), 'Merge these exact contacts', 409)
 assert.deepEqual(await contact(keeper), mergeKeeper)
 assert.equal((await contact(other)).merged_into, null)
 assert.equal(await form(keeper, 'merge').count(), 0, 'a stale merge cannot be resubmitted from the old review')
 await facts(['Harbor Clinic reception · verified'])
 await proof('directory-stale-merge-refused')
 await page.getByRole('link', { name: 'Open fresh merge review', exact: true }).click()
 assert.equal(await form(keeper, 'merge').getByRole('checkbox').isChecked(), false)
 assert.equal(await form(keeper, 'merge').getByRole('checkbox').getAttribute('required'), '')
 assert.equal(await form(keeper, 'merge').locator('[name="otherRevision"]').inputValue(), String((await contact(other)).revision))
 await proof('directory-fresh-merge-review')

 await grant(keeper, { allowMerge: 1 })
 await grant(other, { allowMerge: 1 })
 await authenticate(member.cookie)
 await openMerge(keeper, other)
 await form(keeper, 'merge').getByRole('checkbox').check()
 await proof('directory-member-merge-review')
 await submit(form(keeper, 'merge'), 'Merge these exact contacts')
 assert.equal(new URL(page.url()).pathname, root)
 assert.match(await page.locator('main').innerText(), /grants were withdrawn/i)
 const merged = await contact(keeper)
 for (const key of ['name', 'number', 'extension', 'timezone']) assert.equal(merged[key], mergeKeeper[key], 'merge retains selected keeper ' + key)
 assert.deepEqual(merged.sources, [keeperSource, otherSource].sort())
 assert.equal(merged.suppressed, 1); assert.equal(merged.held, 1)
 assert.equal((await runtime.request(api + '/contacts/' + other, { headers })).status, 403)
 const grants = (await read('/grants')).grants
 assert.equal(grants.some(row => row.contact_id === keeper || row.contact_id === other), false)
 assert.equal((await read('', memberHeaders)).contacts.some(row => row.id === keeper || row.id === other), false)
 await noDetails([merged.name, keeperSource, otherSource])
 await proof('directory-merge-withdraws-both-grants')
 assert.equal((await page.goto(runtime.origin + root + '/' + keeper)).status(), 403)
 await noDetails([merged.name, merged.number, keeperSource, otherSource])
 await proof('directory-merged-member-detail-refused')

 await authenticate(cookie)
 await page.goto(runtime.origin + root + '/' + keeper)
 await page.getByText('Source identities', { exact: true }).click()
 await facts([merged.name, '+15125550191 ext 42', 'Timezone unknown', 'Suppressed', 'Held', keeperSource, otherSource])
 await proof('directory-merged-owner-detail')
 await runtime.sql('ALTER TABLE hnd_contacts RENAME TO synthetic_handset_unavailable')
 try {
  assert.equal((await page.goto(runtime.origin + root)).status(), 503)
  await page.getByRole('alert').waitFor()
  await noDetails([merged.name, privateName, keeperSource, otherSource, 'synthetic_handset_unavailable'])
  await proof('directory-store-unavailable')
 } finally { await runtime.sql('ALTER TABLE synthetic_handset_unavailable RENAME TO hnd_contacts') }
 await runtime.restart()
 await page.goto(runtime.origin + root)
 assert.deepEqual((await read()).contacts.map(row => row.id).sort(), [personal, keeper].sort())
 assert.deepEqual(await contact(keeper), merged)
 await facts([merged.name, privateName])
 await noDetails([memberName])
 await proof('directory-retained-after-restart')
 assert.equal(runtime.sourceRequests.length, sourceRequests, 'native directory work makes no external source requests')
 assert.deepEqual((await runtime.sql('SELECT * FROM hnd_text_permissions')).results, permissions, 'contacts and sharing do not grant messaging permission')
 return root + '/' + personal
}
