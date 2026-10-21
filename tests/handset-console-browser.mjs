import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { openHandset } from './helpers/handset-worker.mjs'
import { signIn,post } from './helpers/handset-auth.mjs'
import { adminCsv,adminFixture } from './helpers/handset-admin.mjs'
import { queueMediaJourney } from './helpers/handset-queue-browser.mjs'
import { queueFixture } from './helpers/handset-queues.mjs'
import { protectionFixture } from './helpers/handset-protection.mjs'
import { metricDataset,metricStart,metricConfig } from './helpers/handset-metrics.mjs'
import { importDataset } from './helpers/handset-import.mjs'

for(const width of [1440,390])for(const domain of ['administration','queues','queue-media','metrics','protection'])test(`${domain} console at ${width}`,async()=>{
 const runtime=await openHandset({twilio:true}),browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage()
 page.setDefaultTimeout(10000)
 const directory=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-console'
 await mkdir(directory,{recursive:true})
 async function proof(name){
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name+' fits viewport')
  assert.equal(await page.locator('h1').count(),1,name+' has a single page heading')
  await page.screenshot({path:`${directory}/${width}-${name}.png`,fullPage:true})
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
  const revise=page.locator('details').filter({has:page.locator('summary',{hasText:'Revise Support'})})
  await revise.locator('summary').click();await revise.getByRole('checkbox').check();await revise.getByRole('button',{name:'Save queue policy',exact:true}).click();await page.getByRole('alert').waitFor();await proof('queue-stale-refusal')
  }
  if(domain==='queue-media')await queueMediaJourney({runtime,page,proof,cookie})
  if(domain==='metrics'){
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
  await page.getByLabel('Send at (UTC)',{exact:true}).fill(new Date(Date.now()+60000).toISOString().slice(0,16))
  await page.getByRole('checkbox',{name:'I consent to this exact scheduled report and recipient',exact:true}).check();await click('Schedule report');await page.waitForURL(runtime.origin+'/app/reports/queues');await proof('report-scheduled')
  await click('Run due reports');assert.ok(!(await page.locator('main').innerText()).includes('accepted'))
  await runtime.scheduled(Date.now()+120000);await page.reload();assert.ok((await page.locator('main').innerText()).includes('accepted'));await proof('report-accepted')
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
  }
  await runtime.sql("UPDATE oa_operators SET status='active' WHERE id='synthetic-handset-2'")
  const member=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'}),[memberName,...memberValue]=member.cookie.split('=')
  await context.clearCookies();await context.addCookies([{name:memberName,value:memberValue.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
  const privatePaths={administration:[['/app/admin/bulk','bulk'],['/app/admin/templates','template']],queues:[['/app/queues','queue']],'queue-media':[['/app/queues/media','queue-media']],metrics:[['/app/reports/queues','report'],['/app/import','import']],protection:[['/app/protection','protection']]}
  for(const [path,name] of privatePaths[domain]){
   await page.goto(runtime.origin+path);await page.getByRole('alert').waitFor();await proof(name+'-permission-denied')
  }
 }finally{await context.close();await browser.close();await runtime.close()}
})
