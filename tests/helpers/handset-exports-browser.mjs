import assert from 'node:assert/strict'
import { mkdir,readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { exportFixture,archiveEdge,range,encryptionKey } from './handset-exports.mjs'

export async function exportsBrowserJourney(width) {
 const edge=archiveEdge(),f=await exportFixture(edge),browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage()
 const directory=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-exports'
 await mkdir(directory,{recursive:true});page.setDefaultTimeout(10000)
 const [name,...parts]=f.cookie.split('=');await context.addCookies([{name,value:parts.join('='),url:f.runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
 async function proof(label) {assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+' fits viewport');assert.equal(await page.getByRole('button').evaluateAll(buttons=>buttons.every(b=>b.textContent.trim().length>2)),true,'buttons have visible text');await page.screenshot({path:`${directory}/${width}-exports-${label}.png`,fullPage:true})}
 const click=async label=>{await page.getByRole('button',{name:label,exact:true}).click();await page.waitForLoadState('load')}
 async function fillRange(form) {await form.getByLabel('From (UTC, inclusive)',{exact:true}).fill(new Date(range.from).toISOString().slice(0,16));await form.getByLabel('To (UTC, exclusive)',{exact:true}).fill(new Date(range.to).toISOString().slice(0,16));await form.getByLabel('Display timezone',{exact:true}).fill(range.timezone)}
 try {
  await page.goto(f.runtime.origin+'/app/exports');await proof('empty')
  const first=await f.media(71);await f.media(72,{audio:false,transcript:false})
  const csv=page.locator('form[action="/app/exports/csv"]');await fillRange(csv)
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download CSV',exact:true}).click()])
  assert.match(await readFile(await download.path(),'utf8'),new RegExp(first.callId));await proof('csv-range')
  await page.getByRole('link',{name:'Settings: buyer archive destinations',exact:true}).click();await page.waitForLoadState('load');await proof('settings-empty')
  await page.locator('select[name="provider"]').selectOption('box');await page.getByLabel('Destination folder ID or absolute path',{exact:true}).fill('synthetic-handset-3300');await page.getByLabel('Scoped destination token (HTTPS providers only)',{exact:true}).fill('synthetic-handset-3301')
  await click('Preview buyer destination');await proof('destination-preview')
  await page.getByLabel('Scoped destination access token (used for this request only)',{exact:true}).fill('synthetic-handset-3301');await page.getByRole('checkbox').check();await click('Connect buyer destination');await proof('destination-connected')
  await page.getByRole('link',{name:'Return to exports',exact:true}).click();await page.waitForLoadState('load')
  await page.getByText('Prepare an archive',{exact:true}).click()
  const prepare=page.locator('form[action="/app/exports/jobs"]');await fillRange(prepare);await prepare.getByLabel('Buyer encryption key (64 lowercase hex characters; keep securely)',{exact:true}).fill(encryptionKey);await prepare.getByRole('checkbox').check();await click('Prepare archive');await proof('archive-review')
  await page.getByRole('checkbox').check();await click('Approve this archive');await proof('archive-approved')
  await page.getByLabel('Buyer encryption key (64 lowercase hex characters; keep securely)',{exact:true}).fill(encryptionKey);await page.getByLabel('Scoped destination access token (used for this request only)',{exact:true}).fill('synthetic-handset-3301');await click('Transfer or resume archive')
  assert.match(await page.locator('main').innerText(),/verified/);assert.match(await page.locator('main').innerText(),/unavailable/);await proof('archive-verified-and-unavailable')
  await click('Revoke future archive transfers');assert.match(await page.locator('main').innerText(),/revoked/);await proof('archive-revoked')
  await page.getByRole('link',{name:'All exports',exact:true}).click();await page.getByText('Schedule an email',{exact:true}).click()
  const schedule=page.locator('form[action="/app/exports/schedules"]');await fillRange(schedule);await schedule.getByLabel('Case owner ID (optional)',{exact:true}).fill('synthetic-handset-1');await schedule.getByLabel('Recipient',{exact:true}).fill('synthetic-handset-recipient@example.test');await schedule.getByLabel('Send at (UTC)',{exact:true}).fill(new Date(Date.now()+3600000).toISOString().slice(0,16));for(const box of await schedule.getByRole('checkbox').all())await box.check()
  await click('Schedule call-log email');assert.match(await page.locator('main').innerText(),/synthetic-handset-recipient@example.test/);assert.match(await page.locator('main').innerText(),/America\/Chicago/);await proof('scheduled-recipient-and-timezone')
  await click('Cancel this email');await proof('schedule-revoked')
  await page.getByRole('link',{name:'Settings: buyer archive destinations',exact:true}).click();await page.waitForLoadState('load');await click('Revoke destination access');assert.match(await page.locator('main').innerText(),/Revoked/);await proof('destination-revoked')
  const restricted=await f.persona('synthetic-handset-3600'),[restrictedName,...restrictedValue]=restricted.cookie.split('=')
  await context.clearCookies();await context.addCookies([{name:restrictedName,value:restrictedValue.join('='),url:f.runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
  assert.equal((await page.goto(f.runtime.origin+'/app/exports')).status(),403);assert.match(await page.locator('main').innerText(),/export_admin_required/);await proof('restricted-supervisor')
 } finally {await context.close();await browser.close();await f.runtime.close()}
}
