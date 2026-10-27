import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { post } from './handset-auth.mjs'
import { captureFixture } from './handset-capture.mjs'

export async function captureBrowser(width) {
 const f=await captureFixture(),runtime=f.runtime
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage()
 const evidence=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-workspace'
 const base='/app/recordings/capture',api='/api/handset/recordings/capture'
 const participants=[{id:'synthetic-handset-101',consent:'yes'},{id:'synthetic-handset-102',consent:'yes'}]
 let id
 page.setDefaultTimeout(10000)
 async function as(cookie) {
  const [name,...value]=cookie.split('=');await context.clearCookies()
  await context.addCookies([{name,value:value.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
 }
 async function proof(name) {
  await page.waitForLoadState('load');await page.evaluate(()=>document.fonts.ready.then(()=>{}))
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name+' fits viewport')
  assert.equal(await page.locator('h1').count(),1)
  assert.equal(await page.getByRole('button').evaluateAll(buttons=>buttons.every(b=>b.textContent.trim().length>2)),true,'capture controls have visible text')
  await page.screenshot({path:`${evidence}/${width}-capture-${name}.png`,fullPage:true})
 }
 async function get() {
  const response=await runtime.request(api+'/'+id,{headers:f.headers});assert.equal(response.status,200)
  return (await response.json()).session
 }
 async function state(expected) {const s=await get();assert.equal(s.state,expected);return s}
 const actionForm=action=>page.locator(`form[action="${base}/${id}/${action}"]`)
 async function submit(action,label,{attest=false}={}) {
  const form=actionForm(action)
  if(attest)await form.getByRole('checkbox').check()
  const button=form.getByRole('button',{name:label,exact:true});await button.focus();await button.press('Enter')
  await page.waitForLoadState('load')
 }
 async function consent(values,jurisdiction='all-party') {
  await page.getByText('Settings: capture consent and retention',{exact:true}).click()
  const form=actionForm('consent')
  await form.getByLabel('Participant jurisdiction policy',{exact:true}).selectOption(jurisdiction)
  await form.getByLabel('Exact participants and consent (JSON)',{exact:true}).fill(JSON.stringify(values,null,2))
  await submit('consent','Save participant consent',{attest:true})
 }
 async function attest() {await submit('announcement','Record human announcement attestation',{attest:true})}
 try {
  await mkdir(evidence,{recursive:true});await as(f.cookie)
  await page.goto(runtime.origin+base);await proof('review-active-call')
  await page.getByLabel('Active native call',{exact:true}).selectOption(f.callId)
  await page.getByLabel('Exact participants and consent (JSON)',{exact:true}).fill(JSON.stringify(participants,null,2))
  await page.getByRole('checkbox',{name:'I reviewed these exact call participants and their consent',exact:true}).check()
  await page.getByRole('button',{name:'Review capture session',exact:true}).click()
  await page.waitForURL(new RegExp('/app/recordings/capture/[0-9a-f-]{36}$'))
  id=new URL(page.url()).pathname.split('/').at(-1)
  await state('blocked');assert.equal(await page.getByRole('button',{name:'Start consented recording',exact:true}).count(),0)
  await proof('unknown-jurisdiction-blocked')
  await consent([{...participants[0],consent:'no'},participants[1]])
  await state('blocked');await proof('participant-refusal')
  await consent(participants);let current=await state('ready');await proof('explicit-consent-ready')
  const before=await post(runtime,api+'/'+id+'/start',{revision:current.revision,confirm:'start this consented recording'},f.headers)
  assert.equal(before.status,409,'capture requires an announcement boundary')
  await state('ready')
  await attest();await proof('human-announcement-attested')
  await submit('start','Start consented recording',{attest:true});await state('capturing');await proof('in-progress')
  await submit('pause','Pause sensitive capture');current=await state('paused');await proof('sensitive-pause')
  const unannounced=await post(runtime,api+'/'+id+'/resume',{revision:current.revision,confirm:'start this consented recording'},f.headers)
  assert.equal(unannounced.status,409,'resume requires its own announcement boundary')
  await state('paused')
  await attest();await proof('resume-announcement-attested')
  await submit('resume','Resume consented recording',{attest:true});await state('capturing');await proof('resumed')
  await submit('stop','Stop recording');await state('stopped');await proof('stopped')
  await page.getByText('Settings: capture consent and retention',{exact:true}).click()
  const retention=actionForm('retention'),retainUntil=new Date(Date.now()+86400000).toISOString().slice(0,16)
  await retention.getByLabel('Retain until (UTC; blank keeps no scheduled end)',{exact:true}).fill(retainUntil)
  await retention.getByLabel('Keep a legal hold on this recording',{exact:true}).check()
  await retention.getByLabel('I reviewed this exact retention date and legal hold',{exact:true}).check()
  await submit('retention','Save retention and hold')
  current=await state('stopped');assert.equal(current.hold,1);assert.equal(current.retain_until,Date.parse(retainUntil+'Z'))
  await page.getByText('Settings: capture consent and retention',{exact:true}).click()
  assert.equal(await page.getByRole('button',{name:'Erase recording and supplied text',exact:true}).isDisabled(),true)
  assert.equal((await post(runtime,api+'/'+id+'/erase',{revision:current.revision,confirm:'erase this exact recording and supplied text'},f.headers)).status,409)
  await proof('retention-and-legal-hold')
  const member=await f.member();await as(member.cookie)
  assert.equal((await page.goto(runtime.origin+base)).status(),403)
  assert.equal(await page.getByRole('alert').count(),1)
  assert.equal(await page.getByRole('button',{name:'Review recording capture',exact:true}).isDisabled(),true)
  await proof('recording-permission-refused')
  assert.equal((await page.goto(runtime.origin+base+'/'+id)).status(),403)
  assert.equal((await runtime.request(api,{headers:{cookie:member.cookie}})).status,403)
  assert.equal((await post(runtime,api+'/'+id+'/start',{revision:current.revision,confirm:'start this consented recording'},{cookie:member.cookie})).status,403)
  await as(f.cookie);await page.goto(runtime.origin+base+'/'+id);await state('stopped')
 } finally {await context.close();await browser.close();await runtime.close()}
}
