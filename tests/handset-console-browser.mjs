import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { openHandset } from './helpers/handset-worker.mjs'
import { signIn,post } from './helpers/handset-auth.mjs'
import { adminCsv,adminFixture } from './helpers/handset-admin.mjs'
import { localDateTime } from './helpers/handset-browser-time.mjs'
import { dialerJourney } from './helpers/handset-dialer-browser.mjs'
import { flowJourney } from './helpers/handset-flow-browser.mjs'
import { promptJourney, speechEdge } from './helpers/handset-prompts-browser.mjs'
import { callbackJourney } from './helpers/handset-callbacks-browser.mjs'
import { queueMediaJourney } from './helpers/handset-queue-browser.mjs'
import { queueFixture } from './helpers/handset-queues.mjs'
import { protectionFixture } from './helpers/handset-protection.mjs'
import { analyticsFixture,analyticsStart,analyticsEnd,analyticsNow } from './helpers/handset-analytics.mjs'
import { metricDataset,metricStart,metricConfig } from './helpers/handset-metrics.mjs'
import { importDataset } from './helpers/handset-import.mjs'

for(const width of [1440,390])for(const domain of ['administration','queues','queue-media','flows','prompts','callbacks','metrics','protection','dialer'])test(`${domain} console at ${width}`,async()=>{
 const runtime=await openHandset({twilio:true,callingClock:domain==='dialer',...(domain==='metrics'?{clockTime:analyticsNow}:{}),...(domain==='prompts'?{ttsEdge:speechEdge}:{})}),browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic',...(domain==='prompts'?['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']:[])]})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage()
 page.setDefaultTimeout(10000)
 const directory=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-console'
 await mkdir(directory,{recursive:true})
 async function proof(name,focus){
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name+' fits viewport')
  assert.equal(await page.locator('h1').count(),1,name+' has a single page heading')
  await page.screenshot({path:`${directory}/${width}-${name}.png`,fullPage:true})
  if(domain==='flows')await page.screenshot({path:`${directory}/${width}-${name}-viewport.png`})
  if(focus)await focus.screenshot({path:`${directory}/${width}-${name}-focus.png`})
  const tree=await page.locator('main').ariaSnapshot()
  assert.match(tree,/heading/,name+' accessibility tree')
 }
 const click=async(button)=>{await page.getByRole('button',{name:button,exact:true}).click();await page.waitForLoadState('load')}
 try{
  const {cookie}=await signIn(runtime),[cookieName,...cookieValue]=cookie.split('=')
  await context.addCookies([{name:cookieName,value:cookieValue.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
  if(domain==='administration'){
  const admin=await adminFixture(runtime,{cookie})
  await page.goto(runtime.origin+'/app');await proof('workspace-navigation')
  await page.goto(runtime.origin+'/app/admin/bulk');await proof('bulk-empty')
  await page.getByLabel('User CSV',{exact:true}).focus();assert.equal(await page.getByLabel('User CSV',{exact:true}).evaluate(el=>el===document.activeElement),true)
  const broken=adminCsv({broken:true}),valid=adminCsv()
  await page.getByLabel('User CSV',{exact:true}).fill(broken.usersCsv);await page.getByLabel('Device CSV',{exact:true}).fill(broken.devicesCsv)
  await click('Preview CSV plan');await page.getByRole('heading',{name:'Review administrative plan',exact:true}).waitFor();await proof('bulk-errors')
  assert.ok((await page.locator('main').innerText()).includes('emergencyAddress'))
  await page.goto(runtime.origin+'/app/admin/bulk')
  await page.getByLabel('User CSV',{exact:true}).fill(valid.usersCsv);await page.getByLabel('Device CSV',{exact:true}).fill(valid.devicesCsv)
  await click('Preview CSV plan');await page.locator('details').first().locator('summary').click();await proof('bulk-reviewed-plan')
  await page.getByRole('checkbox',{name:/I approve this exact local configuration/}).check();await click('Approve exact plan')
  await click('Apply approved plan');await proof('bulk-resumable')
  const planUrl=page.url();await runtime.restart();await page.goto(planUrl)
  for(let step=0;step<10&&await page.getByRole('button',{name:'Resume apply',exact:true}).count();step++)await click('Resume apply')
  assert.ok((await page.locator('main').innerText()).includes('Local configuration completed'))
  await proof('bulk-completed');await page.goto(runtime.origin+'/app/admin/bulk');await proof('bulk-populated')
  const profiles=(await admin.read('/bulk')).profiles,selected=profiles.find(p=>p.kind==='user'&&JSON.parse(p.config).role==='member')
  await page.goto(runtime.origin+'/app/admin/bulk/profiles/'+selected.id);await proof('user-profile')
  await page.getByLabel('Independent override settings JSON').fill(JSON.stringify({greeting:'Rosa’s independent greeting / Saludo personal'}));await click('Save local override');await proof('user-override')
  await page.goto(runtime.origin+'/app/admin/templates');await proof('templates-empty')
  await page.getByLabel('Template name',{exact:true}).fill('Austin reception / Recepción')
  await page.getByLabel('Settings JSON: hours, ringRules, keys, greeting').fill(JSON.stringify({hours:'Monday–Friday 09:00–17:00 America/Chicago',greeting:'Welcome / Bienvenidos',ringRules:'Desk then mobile'}))
  await click('Create template version');await proof('template-version')
  const templateId=new URL(page.url()).pathname.split('/').at(-1)
  await page.getByLabel('Selected profile IDs, comma separated').fill(selected.id);await click('Preview template diff');await page.locator('details').first().locator('summary').click();await proof('template-diff')
  await page.getByRole('checkbox',{name:/I approve this exact local configuration/}).check();await click('Approve exact plan')
  const template=(await admin.read('/templates/'+templateId)).template
  assert.equal((await admin.send('/templates/'+templateId,{version:template.version,name:template.name,kind:template.kind,roleScope:JSON.parse(template.role_scope),settings:{hours:'Monday–Friday 10:00–17:00 America/Chicago',greeting:'Revised welcome'}})).status,200)
  await click('Apply approved plan');await page.getByRole('alert').waitFor();await proof('template-stale-refusal')
  await page.goto(runtime.origin+'/app/admin/templates/'+templateId)
  await page.getByLabel('Selected profile IDs, comma separated').fill(selected.id);await click('Preview template diff')
  await page.getByRole('checkbox',{name:/I approve this exact local configuration/}).check();await click('Approve exact plan');await click('Apply approved plan');await proof('template-completed')
  await page.goto(runtime.origin+'/app/admin/bulk/profiles/'+selected.id);assert.ok((await page.locator('main').innerText()).includes('Rosa’s independent greeting'));await proof('template-preserved-override')
  }
  if(domain==='queues'){
  await page.goto(runtime.origin+'/app/queues');await proof('queues-empty')
  const queues=await queueFixture(runtime,cookie)
  const english=await queues.admit(queues.sales,'en'),spanish=await queues.admit(queues.sales,'es',90)
  await queues.write(queues.base+'/'+queues.sales.id+'/dispatch',{})
  let snapshot=await queues.read()
  assert.equal(snapshot.entries.find(e=>e.id===spanish.id).agent_id,queues.spanish)
  await queues.action(english.id,'accept');await queues.action(spanish.id,'accept')
  await page.goto(runtime.origin+'/app/queues');await proof('queues-active')
  await page.getByRole('button',{name:'Log out of Sales / Ventas',exact:true}).first().click();await page.waitForLoadState('load');await proof('queue-logout-preserves-active')
  snapshot=await queues.read();assert.equal(snapshot.entries.find(e=>e.id===english.id).state,'active')
  await queues.action(english.id,'complete');await page.reload();await proof('queues-wrap-up')
  const waiting=await queues.admit(queues.support,'en')
  await page.reload();await proof('queues-waiting-position')
  await runtime.sql('UPDATE hnd_queue_entries SET deadline_at=? WHERE id=?',Date.now()-1,waiting.id)
  await page.reload();await proof('queues-overflow-held')
  const queueRevision=(await queues.read()).queues.find(q=>q.id===queues.support.id).revision
  await queues.write(queues.base+'/'+queues.support.id+'/configure',{name:'Support / Soporte',mode:'longest_idle',skills:[],maxWaitSeconds:100,wrapSeconds:30,maxWaiting:100,overflowKind:'voicemail',revision:queueRevision,confirm:'approve native queue policy'})
  await page.goto(runtime.origin+'/app/queues/settings')
  const revise=page.locator('details').filter({has:page.locator('summary',{hasText:'Revise Support'})})
  await revise.locator('summary').click();await revise.getByRole('checkbox').check();await revise.getByRole('button',{name:'Save queue policy',exact:true}).click();await page.getByRole('alert').waitFor();await proof('queue-stale-refusal')
  }
  if(domain==='queues'){
   const operator='synthetic-handset-610',agentCookie=(await signIn({...runtime,ownerEmail:operator+'@example.test'})).cookie
   const [agentName,...agentValue]=agentCookie.split('=')
   await context.clearCookies();await context.addCookies([{name:agentName,value:agentValue.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
   await page.goto(runtime.origin+'/app/queues');await page.waitForURL(runtime.origin+'/app/queues/self');await proof('queue-self-available')
   await page.getByLabel('Availability',{exact:true}).selectOption('away');await click('Update my availability');await proof('queue-self-away')
   await click('Log out of Sales / Ventas');await proof('queue-self-sales-logout')
   await page.getByLabel('Wrap-up seconds',{exact:true}).fill('45');await click('Set my wrap-up');await proof('queue-self-wrap')
   const own=await (await runtime.request('/api/handset/queues/self',{headers:{cookie:agentCookie}})).json()
   assert.equal(own.agent.availability,'away');assert.equal(own.memberships.find(m=>m.name==='Sales / Ventas').logged_in,0);assert.ok(own.agent.wrap_until>Date.now())
   assert.equal(await page.getByRole('button',{name:'Configure native agent',exact:true}).count(),0)
  }
  if(domain==='flows')await flowJourney({runtime,page,proof,cookie})
  if(domain==='callbacks')await callbackJourney({runtime,page,proof,cookie})
  if(domain==='prompts'){await context.grantPermissions(['microphone'],{origin:runtime.origin});await promptJourney({runtime,page,proof,cookie})}
  if(domain==='queue-media')await queueMediaJourney({runtime,page,proof,cookie})
  if(domain==='dialer')await dialerJourney({runtime,page,proof})
  if(domain==='metrics'){
  const analytics=await analyticsFixture(runtime)
  const configResponse=await post(runtime,'/api/handset/metrics/config',metricConfig('*',0,{startAt:analyticsStart,endAt:analyticsEnd}),{cookie});assert.equal(configResponse.status,201)
  await page.goto(runtime.origin+'/app/reports/queues/live?queueId=*')
  const nativeText=await page.locator('main').innerText()
  assert.ok(nativeText.includes('6 calls; 1 answered; 5 missed'))
  assert.ok(nativeText.includes('GMT-05:00'));assert.ok(nativeText.includes('GMT-06:00'))
  assert.ok(nativeText.includes('0 of 2'));assert.ok(nativeText.includes('AI sentiment and silence are excluded'))
  await page.getByText('Source calls and recovery cases',{exact:true}).click()
  for(const c of analytics.calls.slice(0,6))assert.equal(await page.getByRole('link',{name:c.recordId,exact:true}).count(),1)
  assert.equal(await page.getByRole('link',{name:analytics.calls[6].recordId,exact:true}).count(),0)
  await proof('customer-report-week')
  await click('Save final report');assert.ok((await page.locator('main').innerText()).includes('6 calls; 1 answered; 5 missed'));await proof('customer-report-history')

  await page.goto(runtime.origin+'/app/import');await proof('import-empty')
  await page.getByLabel('Source JSON',{exact:true}).fill(JSON.stringify(metricDataset()))
  await click('Upload and review plan');await page.getByRole('heading',{name:'Review exact import plan',exact:true}).waitFor();await proof('import-plan')
  await page.getByRole('checkbox',{name:'I approve this exact fingerprint and these differences',exact:true}).check();await click('Apply this reviewed plan')
  for(let i=0;i<20&&await page.getByRole('button',{name:'Resume reviewed apply',exact:true}).count();i++){
   await page.getByRole('checkbox',{name:'I approve resuming this reviewed fingerprint',exact:true}).first().check();await page.getByRole('button',{name:'Resume reviewed apply',exact:true}).first().click();await page.waitForLoadState('load')
  }
  await proof('import-applied')
  await page.getByRole('button',{name:'Reconcile against native datasets',exact:true}).click();await page.waitForLoadState('load');await proof('import-reconciled')
  await page.goto(runtime.origin+'/app/reports/queues');await proof('reports-empty')
  await page.getByLabel('Queue ID',{exact:true}).fill('queue-A')
  await page.getByLabel('Interval start (UTC)',{exact:true}).fill(new Date(metricStart).toISOString().slice(0,16))
  await page.getByLabel('Interval end (UTC, excluded)',{exact:true}).fill(new Date(metricStart+1200000).toISOString().slice(0,16))
  await click('Save versioned formula');assert.ok((await page.locator('main').innerText()).includes('40.00%'))
  assert.equal(await page.locator('dd').first().evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length}),1,'service-level ratio is readable on one line')
  await proof('metrics-live')
  await click('Save final report');await proof('metrics-final-history')
  await page.goto(runtime.origin+'/app/reports/queues/live?queueId=queue-A')
  await page.getByLabel('Service-level method',{exact:true}).selectOption('exclude-abandons');await click('Save versioned formula')
  assert.ok((await page.locator('main').innerText()).includes('50.00%'));await proof('metrics-changed-method')
  await page.getByLabel('Answer target T (seconds)',{exact:true}).fill('30')
  await page.getByLabel('Short-abandon threshold S (seconds)',{exact:true}).fill('0')
  await page.getByLabel('Service-level method',{exact:true}).selectOption('include-abandons');await click('Save versioned formula')
  assert.ok((await page.locator('main').innerText()).includes('66.67%'));await proof('metrics-changed-thresholds')
  await page.getByLabel('Send at (UTC)',{exact:true}).fill(localDateTime(domain==='metrics'?analyticsNow+60000:Date.now()+60000))
  await page.getByRole('checkbox',{name:'I consent to this exact scheduled report and recipient',exact:true}).check();await click('Schedule report');await page.waitForURL(runtime.origin+'/app/reports/queues');await proof('report-scheduled')
  await click('Run due reports');assert.ok(!(await page.locator('main').innerText()).includes('accepted'))
  await runtime.scheduled(analyticsNow+120000);await page.reload();assert.ok((await page.locator('main').innerText()).includes('accepted'));await proof('report-accepted')
  const partial=metricDataset();delete partial.entries[0].closedAt;await importDataset(runtime,cookie,partial,true)
  await page.goto(runtime.origin+'/app/reports/queues/live?queueId=queue-A');assert.equal(await page.getByRole('button',{name:'Save final report',exact:true}).isDisabled(),true);await proof('metrics-provisional')
  assert.equal((await post(runtime,'/api/handset/metrics/config',metricConfig('queue-empty'),{cookie})).status,201)
  await page.goto(runtime.origin+'/app/reports/queues/live?queueId=queue-empty');assert.ok((await page.locator('main').innerText()).includes('Unavailable (zero denominator)'));await proof('metrics-zero-denominators')
  }
  if(domain==='protection'){
  await page.goto(runtime.origin+'/app/protection');await proof('protection-empty')
  const protection=await protectionFixture(runtime,{populated:true})
  await page.reload();await proof('protection-alert-and-rules')
  await page.getByRole('button',{name:'Acknowledge alert',exact:true}).first().click();await page.waitForLoadState('load');await proof('protection-acknowledged')
  await page.getByLabel('Device identifier',{exact:true}).fill('synthetic-handset-990')
  await page.getByLabel('Unique attempt identifier',{exact:true}).fill('synthetic-handset-991')
  await page.getByLabel('Caller or destination (E.164, anonymous, or 911)',{exact:true}).fill('+15125550127')
  await click('Check and record decision');await proof('protection-blocked-decision')
  const checkAgain=page.getByRole('link',{name:'Return to protection',exact:true})
  if(await checkAgain.count())await checkAgain.click();else await page.goto(runtime.origin+'/app/protection')
  await page.getByLabel('Unique attempt identifier',{exact:true}).fill('synthetic-handset-992')
  await page.getByLabel('Device identifier',{exact:true}).fill('synthetic-handset-990')
  await page.getByLabel('Caller or destination (E.164, anonymous, or 911)',{exact:true}).fill('+15125550126')
  await click('Check and record decision');await proof('protection-allowed-decision')
  await page.goto(runtime.origin+'/app/protection')
  const ruleForm=page.locator('form').filter({has:page.getByRole('button',{name:'Apply rule',exact:true})})
  await ruleForm.getByLabel('Business number',{exact:true}).selectOption(protection.numberId)
  await ruleForm.getByLabel('Channel',{exact:true}).selectOption('voice')
  await ruleForm.getByLabel('Match',{exact:true}).selectOption('number')
  await ruleForm.getByLabel('Number or prefix (leave empty for anonymous)',{exact:true}).fill('+12125550129')
  await ruleForm.getByLabel('Action',{exact:true}).selectOption('screen')
  await ruleForm.getByRole('checkbox').check();await ruleForm.getByRole('button',{name:'Apply rule',exact:true}).click();await page.waitForLoadState('load')
  await page.goto(runtime.origin+'/app/protection')
  const challenge=await protection.startScreening({CallSid:'synthetic-handset-1710',From:'+12125550129'})
  await page.reload();await proof('protection-screening-pending')
  const continuation=await challenge.answer();assert.equal(continuation.status,200);assert.ok((await continuation.text()).includes(protection.continuation))
  await page.reload();await proof('protection-screening-passed')
  assert.equal((await protection.overview()).challenges.find(c=>c.call_sid==='synthetic-handset-1710').status,'passed')
  assert.equal((await challenge.answer()).status,409)

  await page.goto(runtime.origin+'/app/protection')
  const windowForm=page.locator('form[action="/app/protection/callback-window"]')
  await windowForm.getByLabel('Business number',{exact:true}).selectOption(protection.numberId)
  await windowForm.getByLabel('Post-911 callback window (minutes, at least 60)',{exact:true}).fill('120')
  await windowForm.getByRole('checkbox').check();await windowForm.getByRole('button').click();await page.waitForLoadState('load')
  const emergency=await protection.carrier({CallSid:'synthetic-handset-1711',From:'sip:synthetic-handset-1712@synthetic-handset-1713.example.test',To:'sip:911@synthetic-handset-1713.example.test',SipUsername:'synthetic-handset-1712'})
  assert.equal(emergency.status,200)
  await page.reload();await proof('protection-post911-window')
  const callbackForm=page.locator('form[action="/app/protection/callbacks"]')
  await callbackForm.getByLabel('Business number',{exact:true}).selectOption(protection.numberId)
  await callbackForm.getByLabel('Expected callback number',{exact:true}).fill('+12125550142')
  await callbackForm.getByLabel('Expires at (UTC)',{exact:true}).fill(new Date(Date.now()+3*86400000).toISOString().slice(0,16))
  await callbackForm.getByRole('checkbox').check();await callbackForm.getByRole('button').click();await page.waitForLoadState('load');await proof('protection-standing-designation')

  }
  await runtime.sql("UPDATE oa_operators SET status='active' WHERE id='synthetic-handset-2'")
  const member=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'}),[memberName,...memberValue]=member.cookie.split('=')
  await context.clearCookies();await context.addCookies([{name:memberName,value:memberValue.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
  const privatePaths={flows:[['/app/flows','flows']],administration:[['/app/admin/bulk','bulk'],['/app/admin/templates','template']],queues:[['/app/queues','queue']],'queue-media':[['/app/queues/media','queue-media']],metrics:[['/app/reports/queues','report'],['/app/import','import']],protection:[['/app/protection','protection']],dialer:[['/app/dialer','dialer']],prompts:[['/app/prompts','prompts']],callbacks:[['/app/callbacks','callbacks']]}
  for(const [path,name] of privatePaths[domain]){
   await page.goto(runtime.origin+path);await page.getByRole('alert').waitFor();await proof(name+'-permission-denied')
  }
 }finally{await context.close();await browser.close();await runtime.close()}
})

// These journeys exercise the four customer-work screens through native owner forms.
for (const width of [1440, 390]) for (const domain of ['rules', 'followups', 'recovery', 'operations']) test(`${domain} owner workflow at ${width}`, async () => {
 const { receptionistFixture } = await import('./helpers/handset-receptionist.mjs')
 const { workJourney } = await import('./helpers/handset-workflows-browser.mjs')
 const f = await receptionistFixture({ clockTime: domain === 'recovery' ? Date.parse('2026-10-26T18:00:00Z') : undefined }), browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
 const context = await browser.newContext({ viewport: { width, height: 960 }, ignoreHTTPSErrors: true }), page = await context.newPage()
 const directory = process.env.HANDSET_EVIDENCE_DIR ?? '.cache/handset-console'
 await mkdir(directory, { recursive: true }); page.setDefaultTimeout(10000)
 const authenticate = async cookie => { const [name, ...value] = cookie.split('='); await context.clearCookies(); await context.addCookies([{ name, value: value.join('='), url: f.runtime.origin, secure: true, httpOnly: true, sameSite: 'Lax' }]) }
 const proof = async name => {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ' fits viewport')
  assert.equal(await page.locator('h1').count(), 1)
  assert.equal(await page.locator('button, a, summary').evaluateAll(controls => controls.every(c => c.textContent.trim().length > 2)), true, 'Every control has a visible label; no icon-only control needs a tooltip')
  assert.match(await page.locator('main').ariaSnapshot(), /heading/)
  await page.screenshot({ path: `${directory}/${width}-${name}.png`, fullPage: true })
  if (name.startsWith('recovery-intake')) await page.getByText('Settings: missed-call intake', { exact: true }).locator('..').screenshot({ path: `${directory}/${width}-${name}-settings.png` })
 }
 try {
  await authenticate(f.headers.cookie)
  await workJourney({ f, page, proof, domain })
  await f.runtime.sql("UPDATE oa_operators SET role='member' WHERE id='synthetic-handset-2'")
  const member = await signIn({ ...f.runtime, ownerEmail: 'synthetic-handset-2@example.test' }); await authenticate(member.cookie)
  const denied = await page.goto(f.runtime.origin + '/app/' + domain); assert.equal(denied.status(), 403)
  await page.getByRole('alert').waitFor(); await proof(domain + '-permission-denied')
  await context.clearCookies()
  await page.goto(f.runtime.origin + '/app/' + domain); assert.match(new URL(page.url()).pathname, /signin/)
 } finally { await context.close(); await browser.close(); await f.runtime.close() }
})

for(const width of [1440,390])test(`Owner dataset erasure settings and committed refusal states at ${width}`,async()=>{
 const {minimalDataset}=await import('./helpers/handset-import.mjs')
 const runtime=await openHandset(),browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage()
 const directory=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-console'
 await mkdir(directory,{recursive:true})
 async function proof(name){
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name)
  assert.equal(await page.locator('button').evaluateAll(rows=>rows.every(row=>row.textContent.trim().length>0)),true,'every control has a visible label')
  await page.screenshot({path:`${directory}/${width}-erasure-${name}.png`,fullPage:true})
 }
 async function cookieFor(cookie){const [name,...value]=cookie.split('=');await context.clearCookies();await context.addCookies([{name,value:value.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])}
 try{
  const {cookie}=await signIn(runtime);await cookieFor(cookie)
  await page.goto(runtime.origin+'/app/admin/erasure');await proof('empty')
  await importDataset(runtime,cookie,minimalDataset(1900))
  await page.goto(runtime.origin+'/app/import')
  await page.getByRole('link',{name:'Erase imported queue data',exact:true}).click();await proof('populated')
  await runtime.sql("UPDATE hnd_metric_datasets SET revision=revision+1 WHERE id='synthetic-handset-1900'")
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Erase dataset',exact:true}).click()
  await page.getByRole('alert').waitFor();assert.match(await page.locator('main').innerText(),/dataset changed/);await proof('stale')
  await page.goto(runtime.origin+'/app/admin/erasure')
  await runtime.sql("CREATE TRIGGER synthetic_browser_erasure_failure BEFORE DELETE ON hnd_metric_datasets BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END")
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Erase dataset',exact:true}).click()
  await page.getByRole('alert').waitFor();await proof('failed')
  await runtime.sql('DROP TRIGGER synthetic_browser_erasure_failure')
  await page.goto(runtime.origin+'/app/admin/erasure')
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Erase dataset',exact:true}).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('heading',{name:'Dataset deletion committed',exact:true}).waitFor();await proof('committed')
  assert.match(await page.locator('main').innerText(),/Complete installation erasure is unavailable/)
  await page.getByRole('link',{name:'Return to erasure settings',exact:true}).click();await proof('receipt')
  assert.match(await page.locator('main').innerText(),/No imported datasets remain/)
  await runtime.sql("UPDATE oa_operators SET status='active',role='admin' WHERE id='synthetic-handset-2'")
  const other=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'});await cookieFor(other.cookie)
  await page.goto(runtime.origin+'/app/admin/erasure');await page.getByRole('alert').waitFor();await proof('denied')
  assert.equal((await post(runtime,'/api/handset/erasure/erase',{entity:'queue-dataset'}, {cookie:other.cookie})).status,403)
 }finally{await context.close();await browser.close();await runtime.close()}
})
