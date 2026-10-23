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
