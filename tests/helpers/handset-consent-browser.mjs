import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { consentFixture,oneReplyJourney,surveyJourney,consentTime } from './handset-consent.mjs'
import { signIn } from './handset-auth.mjs'

export async function consentBrowserJourney(width,domain) {
 const f=await consentFixture(),browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage()
 const directory=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-consent'
 await mkdir(directory,{recursive:true});page.setDefaultTimeout(10000)
 async function cookie(value) {const [name,...parts]=value.split('=');await context.addCookies([{name,value:parts.join('='),url:f.runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])}
 async function proof(name) {
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name+' fits viewport')
  assert.equal(await page.locator('h1').count(),1)
  assert.equal(await page.getByRole('button').evaluateAll(buttons=>buttons.every(b=>b.textContent.trim().length>2)),true,'all buttons have visible text; no icon-only controls')
  await page.screenshot({path:`${directory}/${width}-${domain}-${name}.png`,fullPage:true})
 }
 try {
  await cookie(f.source.cookie)
  const path='/app/'+domain
  await page.goto(f.runtime.origin+path);await proof('empty')
  if(domain==='consent') {
   await oneReplyJourney(f)
   const decline=await f.start(2);await decline.decision('2');await decline.missed()
   const stopped=await f.start(3);await stopped.decision('1');await f.stop(stopped);await stopped.missed()
   await page.reload();await page.getByRole('heading',{name:'Consent evidence',exact:true}).waitFor()
   await page.getByText('Inspect permission',{exact:true}).first().click()
   assert.match(await page.locator('main').innerText(),/recipient_STOP_or_DNC/)
   assert.match(await page.locator('main').innerText(),/explicit caller permission/)
   await proof('permission-and-suppressed')
   await page.getByText('Settings: reviewed consent policy',{exact:true}).click()
   await page.getByLabel('Business name',{exact:true}).focus();assert.equal(await page.getByLabel('Business name',{exact:true}).evaluate(el=>el===document.activeElement),true)
   await proof('reviewed-settings')
   await page.getByRole('button',{name:'Revoke policy',exact:true}).click();await page.waitForLoadState('load');await proof('revoked')
   const after=await f.signed(f.configured.providerPath,stopped.fields)
   assert.ok(after.status>=400)
  } else {
   const {calls}=await surveyJourney(f)
   await page.reload();assert.match(await page.locator('main').innerText(),/3\.50/);assert.match(await page.locator('main').innerText(),/66\.7%/);assert.match(await page.locator('main').innerText(),/Declined/);assert.match(await page.locator('main').innerText(),/Suppressed/)
   await proof('ratings-and-denominators')
   await page.getByLabel('Customer call',{exact:true}).selectOption(calls[8].canonical.recordId)
   await page.getByLabel('Channel',{exact:true}).selectOption('ivr')
   await page.getByRole('button',{name:'Create optional post-call survey invitation',exact:true}).click();await page.waitForLoadState('load');await proof('approved-invitation')
   await f.runtime.setTime(consentTime+8*86400000);await cookie((await signIn(f.runtime)).cookie)
   await page.goto(f.runtime.origin+path);assert.match(await page.locator('main').innerText(),/No response/);await proof('no-response')
  }
 } finally {await context.close();await browser.close();await f.runtime.close()}
}
