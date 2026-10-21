import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { openHandset } from './helpers/handset-worker.mjs'
import { mailLink, post, privateReads, privateWrites } from './helpers/handset-auth.mjs'
import { receivedLink } from './helpers/handset-mailbox.mjs'

for (const width of [1440, 390]) test(`Native forms, public doors and revoked access at ${width}`, async () => {
  const liveMail = process.env.HANDSET_LIVE_MAIL === '1'
  const runtime = await openHandset({ liveMail })
  const browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
  const context = await browser.newContext({ viewport: { width, height: 960 }, ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await mkdir('.cache/handset-auth', { recursive: true })
  async function screenshot(state) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${state} fits ${width}`)
    await page.screenshot({ path: `.cache/handset-auth/${width}-${state}.png`, fullPage: true })
  }
  try {
    await page.goto(runtime.origin + '/')
    await page.getByRole('link', { name: 'Sign in', exact: true }).click()
    await page.getByLabel('Email', { exact: false }).fill(runtime.ownerEmail)
    const since = Date.now()
    await Promise.all([
      page.waitForURL(url => url.searchParams.get('notice') === 'sent'),
      page.getByRole('button', { name: 'Email a sign-in link' }).click(),
    ])
    await screenshot('signin-sent')
    const link = liveMail ? await receivedLink(runtime, since) : mailLink(runtime.mails.at(-1))
    await page.goto(link.href)
    assert.equal((await context.cookies()).some(cookie => cookie.name.includes('operator_session')), false, 'preview does not sign in')
    await screenshot('confirm')
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await page.waitForURL(runtime.origin + '/app')
    assert.ok((await page.locator('main').innerText()).includes('Mara Patel'), 'native operator document rendered')
    await screenshot('app')
    const retainedCookie = (await context.cookies()).filter(cookie => cookie.name.includes('operator_session')).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    assert.ok(retainedCookie)
    const crossOrigin = await context.request.post(runtime.origin + '/auth/signout', { headers: { origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' }, data: {} })
    assert.equal(crossOrigin.status(), 403)
    for (const [path, input] of privateWrites) {
      assert.equal((await context.request.post(runtime.origin + path, { headers: { origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' }, data: input })).status(), 403, path)
    }
    assert.equal((await context.request.get(runtime.origin + '/auth/session')).status(), 200)
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.waitForURL(runtime.origin + '/signin')
    await screenshot('signed-out')
    for (const path of privateReads) assert.equal((await runtime.request(path, { headers: { cookie: retainedCookie } })).status, 401, path)
    await page.goto(runtime.origin + '/app/calls')
    assert.equal(new URL(page.url()).pathname, '/signin')
    assert.ok(!(await page.locator('body').innerText()).includes('Mara Patel'))
    const replay = await post(runtime, '/auth/confirm', { token: link.searchParams.get('token') })
    assert.equal(replay.status, 400)
    for (const path of ['/health', '/setup/state', '/.well-known/rer-dependencies', '/auth/dependencies/status']) assert.equal((await context.request.get(runtime.origin + path)).status(), 200, path)
    assert.equal((await post(runtime, '/api/carriers/twilio/callback', {}, { 'x-twilio-signature': 'synthetic-handset-8' })).status, 401)
    const unknown = await post(runtime, '/auth/magic-link', { email: 'synthetic-handset-7@example.test' })
    const inactive = await post(runtime, '/auth/magic-link', { email: 'synthetic-handset-2@example.test' })
    assert.equal(unknown.status, 202)
    assert.equal(inactive.status, unknown.status)
    assert.equal(await unknown.text(), await inactive.text())
    let throttled = false
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await post(runtime, '/auth/magic-link', { email: 'synthetic-handset-7@example.test' })).status === 429) { throttled = true; break }
    }
    assert.ok(throttled, 'public email requests are throttled')
  } finally {
    await context.close()
    await browser.close()
    await runtime.close()
  }
})
