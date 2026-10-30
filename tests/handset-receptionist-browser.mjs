import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { receptionistFixture } from './helpers/handset-receptionist.mjs'

for (const width of [1440, 390]) test(`Named person reviews and decides exact caller exceptions at ${width}`, async () => {
 const f = await receptionistFixture(), browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
 const directory = process.env.HANDSET_EVIDENCE_DIR ?? '.cache/handset-receptionist'
 await mkdir(directory, { recursive: true })
 const session = async cookie => { const context = await browser.newContext({ viewport: { width, height: 960 }, ignoreHTTPSErrors: true }), [name, ...value] = cookie.split('='); await context.addCookies([{ name, value: value.join('='), url: f.runtime.origin, secure: true, httpOnly: true, sameSite: 'Lax' }]); const page = await context.newPage(); page.setDefaultTimeout(10000); return page }
 async function proof(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ' fits the viewport')
  assert.equal(await page.locator('h1').count(), 1, name + ' has one heading')
  assert.equal(await page.getByRole('button').evaluateAll(buttons => buttons.every(b => b.textContent.trim().length > 2)), true, name + ' has no icon-only controls')
  await page.screenshot({ path: `${directory}/${width}-${name}.png`, fullPage: true })
 }
 try {
  const named = await session(f.named.cookie), owner = await session(f.headers.cookie)
  await f.savePolicy()
  await named.goto(f.runtime.origin + '/app/receptionist'); await proof(named, 'empty')
  assert.ok((await named.locator('main').innerText()).includes('No exceptions yet'))
  f.edges.slots.push(new Date(Date.now() + 172800000).toISOString())
  const es = await f.open(1, 'es', f.cases[1]), esBase = `outcomes/${es.outcome.id}/`
  const conflict = await f.ok(esBase + 'knowledge', { facts: [{ topic: 'deposit', value: '$25.00', sourceId: 'synthetic-handset-slate-2', version: 'k-11' }] })
  const en = await f.open(2, 'en', f.cases[0]), base = `outcomes/${en.outcome.id}/`
  await f.ok(base + 'availability', { serviceId: 'furnace' }); f.edges.drop.add('dial')
  await f.ok(base + 'booking', { serviceId: 'furnace', startAt: f.edges.slots[0] })
  await named.reload(); await proof(named, 'pending-exceptions')
  const card = named.locator('#exception-' + conflict.escalated[0])
  assert.ok((await card.innerText()).includes('$25.00') && (await card.innerText()).includes('Rosa García'), 'the exact claim and caller are on the card')
  assert.ok((await named.locator('main').innerText()).includes('booking uncertain'), 'the lost booking answer is shown as uncertain')
  await owner.goto(f.runtime.origin + '/app/receptionist'); await proof(owner, 'not-the-named-person')
  await owner.locator('#exception-' + conflict.escalated[0]).getByRole('button', { name: 'Approve this exact request', exact: true }).click()
  await owner.getByRole('alert').filter({ hasText: 'named person required' }).waitFor(); await proof(owner, 'denied-not-named')
  await card.getByRole('button', { name: 'Approve this exact request', exact: true }).click()
  await named.waitForURL(/#exception-/); await proof(named, 'decided')
  assert.match(await named.locator('#exception-' + conflict.escalated[0]).innerText(), /approved/)
  const stale = await session(f.named.cookie)
  const response = await stale.request.post(f.runtime.origin + `/app/receptionist/exceptions/${conflict.escalated[0]}/decision`, { form: { decision: 'approve', confirm: 'decide exact exception', note: '' }, headers: { origin: f.runtime.origin }, failOnStatusCode: false })
  assert.equal(response.status(), 409)
  await stale.goto(f.runtime.origin + '/app/receptionist'); await proof(stale, 'after-decision')
 } finally { await browser.close(); await f.runtime.close() }
})


for (const width of [1440, 390]) test(`Connector repair keeps lost effects uncertain when access expires at ${width}`, async () => {
 const f = await receptionistFixture(), browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
 const directory = process.env.HANDSET_EVIDENCE_DIR ?? '.cache/handset-receptionist'
 await mkdir(directory, { recursive: true })
 const context = await browser.newContext({ viewport: { width, height: 960 }, ignoreHTTPSErrors: true }), page = await context.newPage()
 const [name, ...value] = f.headers.cookie.split('=')
 await context.addCookies([{ name, value: value.join('='), url: f.runtime.origin, secure: true, httpOnly: true, sameSite: 'Lax' }])
 async function proof(label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.equal(await page.getByRole('button').evaluateAll(buttons => buttons.every(button => button.textContent.trim().length > 2)), true)
  await page.screenshot({ path: `${directory}/${width}-repair-${label}.png`, fullPage: true })
 }
 try {
  await f.savePolicy()
  const opened = await f.open(91, 'en', f.cases[0]), base = `outcomes/${opened.outcome.id}/`
  f.edges.drop.add('orbit')
  const lost = await f.ok(base + 'handoffs\/crm', { summary: 'A callback estimate needs receiver confirmation' })
  assert.equal(lost.step.state, 'uncertain'); assert.equal(f.edges.effects.size, 1)
  await page.goto(f.runtime.origin + '/app/receptionist')
  await page.getByText(/crm uncertain — orbit response lost/).waitFor(); await proof('lost')
  f.edges.orbitExpired = true
  await f.runtime.restart()
  await f.ok(base + 'reconcile', { step: 'crm' })
  await page.reload()
  await page.getByText(/crm uncertain — orbit credential refused/).waitFor(); await proof('access-refused')
  f.edges.orbitExpired = false
  await f.ok(base + 'reconcile', { step: 'crm' })
  await page.reload()
  await page.getByText(/crm confirmed — readback matched/).waitFor(); await proof('readback')
  assert.equal(f.edges.effects.size, 1)
  // A known booking remains repairable without repeating its creation request.
  const call = await f.open(92, 'en', f.cases[1]), bookingBase = `outcomes/${call.outcome.id}/`
  f.edges.slots.push(new Date(Date.now() + 172800000).toISOString())
  await f.ok(bookingBase + 'availability', { serviceId: 'furnace' })
  const bookingId = 'synthetic-handset-booking-1', readUrl = f.edges.origins.dial + '/api/app/bookings/' + bookingId
  f.edges.readFailures.set(readUrl, 503)
  const booking = await f.ok(bookingBase + 'booking', { serviceId: 'furnace', startAt: f.edges.slots[0] })
  assert.equal(booking.step.externalId, bookingId)
  await page.reload(); await page.getByText(/booking uncertain — dial readback unavailable/).waitFor(); await proof('known-booking')
  const writes = f.edges.requests.filter(r => r.method === 'POST').length
  f.edges.readFailures.set(readUrl, 403)
  await f.runtime.restart(); await f.ok(bookingBase + 'reconcile', { step: 'booking' })
  await page.reload(); await page.getByText(/booking uncertain — dial booking out of scope/).waitFor(); await proof('booking-scope-refused')
  f.edges.readFailures.delete(readUrl)
  await f.ok(bookingBase + 'reconcile', { step: 'booking' })
  await page.reload(); await page.getByText(/booking confirmed — readback matched/).waitFor(); await proof('booking-readback')
  assert.equal(f.edges.requests.filter(r => r.method === 'POST').length, writes)
  assert.equal(f.edges.bookings.size, 1)
  const headers = { authorization: 'Bearer ' + f.issued.token }
  assert.equal((await f.runtime.request('/api/handset/delivery', { headers })).status, 401)
 } finally { await context.close(); await browser.close(); await f.runtime.close() }
})

for(const width of [1440,390])for(const domain of ['consent','surveys'])test(`${domain} owner workflow at ${width}`,async()=>{
 const {consentBrowserJourney}=await import('./helpers/handset-consent-browser.mjs')
 await consentBrowserJourney(width,domain)
})

for(const width of [1440,390])test(`call-log exports owner workflow at ${width}`,async()=>{
 const {exportsBrowserJourney}=await import('./helpers/handset-exports-browser.mjs')
 await exportsBrowserJourney(width)
})
