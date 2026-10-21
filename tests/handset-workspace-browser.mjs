import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { openHandset } from './helpers/handset-worker.mjs'
import { signIn, post } from './helpers/handset-auth.mjs'
import { recordsFixture } from './handset-records.mjs'
for(const width of [1440,390])test(`Native case work, conflict and source drill-through at ${width}`,async()=>{
 const runtime=await openHandset(),browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage()
 const evidence=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-workspace'
 await mkdir(evidence,{recursive:true})
 async function proof(name){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name);await page.screenshot({path:`${evidence}/${width}-${name}.png`,fullPage:true})}
 try{
  const {cookie}=await signIn(runtime),[name,...value]=cookie.split('=')
  await context.addCookies([{name,value:value.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
  await page.goto(runtime.origin+'/app/cases');await proof('empty-cases')
  const {caseId}=await recordsFixture(runtime,cookie)
  await page.reload();await page.getByLabel('Search / Buscar').fill('replacement');await page.getByRole('button',{name:'Search cases',exact:true}).click()
  await page.getByRole('link',{name:'Austin service callback / Devolución de llamada',exact:true}).click()
  await proof('case-timeline')
  assert.ok((await page.locator('body').innerText()).includes('uncertain'))
  const current=await (await runtime.request('/api/handset/cases/'+caseId,{headers:{cookie}})).json()
  assert.equal((await post(runtime,'/api/handset/cases/'+caseId,{title:'Owner changed the case',version:current.current.version,promise:current.current.promise,dueAt:current.current.due_at},{cookie})).status,200)
  await page.getByLabel('Case title / Asunto').fill('Stale edit')
  const conflict=page.waitForResponse(response=>response.url().endsWith('/edit') && response.status()===409)
  await page.getByRole('button',{name:'Save case / Guardar caso',exact:true}).click();await conflict
  await page.getByRole('alert').filter({hasText:'Another teammate'}).waitFor();await proof('case-conflict')
  await page.getByLabel('Comment',{exact:true}).fill('Confirmar la cita / Confirm the appointment')
  await page.getByRole('button',{name:'Add comment',exact:true}).click();await page.waitForURL(runtime.origin+'/app/cases/'+caseId)
  await page.getByRole('link',{name:/provider_attempt/}).click();await proof('source-record')
  await page.goto(runtime.origin+'/app/audit');await page.getByRole('heading',{name:'Accountable audit',exact:true}).waitFor();await proof('audit')
  await page.goto(runtime.origin+'/app/cases?q=synthetic-handset-no-match');await proof('no-matches')
  const member='synthetic-handset-2'
  await runtime.sql("UPDATE oa_operators SET status='active' WHERE id=?",member)
  const memberSession=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  const [memberName,...memberValue]=memberSession.cookie.split('=')
  await context.clearCookies();await context.addCookies([{name:memberName,value:memberValue.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
  await page.goto(runtime.origin+'/app/cases');await page.getByRole('alert').waitFor();await proof('permission-denied')
  assert.ok(!(await page.locator('body').innerText()).includes('Austin service'))
 }finally{await context.close();await browser.close();await runtime.close()}
})
