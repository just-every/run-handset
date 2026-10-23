import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { openHandset } from './helpers/handset-worker.mjs'
import { signIn, post } from './helpers/handset-auth.mjs'
import { sourceFixture } from './helpers/handset-sources.mjs'
import { recordsFixture } from './helpers/handset-records.mjs'
for(const width of [1440,390])test(`Native case work, conflict and source drill-through at ${width}`,async()=>{
 const runtime=await openHandset({twilio:true}),browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage()
 const evidence=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-workspace'
 await mkdir(evidence,{recursive:true})
 async function proof(name){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name);await page.screenshot({path:`${evidence}/${width}-${name}.png`,fullPage:true})}
 try{
  const {cookie}=await signIn(runtime),[name,...value]=cookie.split('=')
  await context.addCookies([{name,value:value.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
  await page.goto(runtime.origin+'/app/cases');await proof('empty-cases')
  const {caseId,entries}=await recordsFixture(runtime,cookie)
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
  await page.getByRole('link',{name:'Add native source record',exact:true}).click()
  await page.getByLabel('Record type',{exact:true}).selectOption('message');await page.getByRole('button',{name:'Choose record type',exact:true}).click()
  await page.getByLabel('Channel',{exact:true}).selectOption('mms')
  await page.getByLabel('Direction',{exact:true}).selectOption('outbound')
  await page.getByLabel('Transport or work state').selectOption('uncertain')
  await page.getByLabel('text',{exact:true}).fill('Native delivery remains unconfirmed')
  await proof('native-record-form')
  await page.getByRole('button',{name:'Add unverified record',exact:true}).click()
  await page.waitForURL(runtime.origin+'/app/cases/'+caseId)
  assert.ok((await page.locator('body').innerText()).includes('Native delivery remains unconfirmed'))
  await page.getByRole('link',{name:/provider_attempt/}).click();await proof('source-record')
  await page.goto(runtime.origin+'/app/audit');await page.getByRole('heading',{name:'Accountable audit',exact:true}).waitFor();await proof('audit')
  await page.goto(runtime.origin+'/app/grants');await proof('empty-grants')
  await page.getByLabel('Application name',{exact:true}).fill('Browser receptionist')
  await page.getByLabel('Permission preset').selectOption('receptionist')
  await page.getByLabel('Selected case IDs, comma separated').fill(caseId)
  await page.getByLabel('Selected number IDs, comma separated').fill(entries.number.id)
  await page.getByLabel('Selected person recipient IDs, comma separated').fill(entries.person.id)
  await page.getByLabel('Budget in USD cents').fill('100')
  await page.getByRole('checkbox',{name:'I approve these exact scopes and selections'}).check()
  await page.getByRole('button',{name:'Issue credential',exact:true}).click()
  await page.getByRole('heading',{name:'Credential issued',exact:true}).waitFor()
  const token=await page.locator('code').innerText()
  // Deliberately do not screenshot the one-time credential page.
  await page.getByRole('link',{name:'Return to application grants',exact:true}).click();await proof('populated-grants')
  const grants=await (await runtime.request('/api/handset/grants',{headers:{cookie}})).json()
  const grant=grants.grants.find(g=>g.name==='Browser receptionist')
  const native=await (await runtime.request('/api/handset/cases/'+caseId,{headers:{cookie}})).json()
  const state={operation:'call.paid',caseId,caseVersion:native.current.version,numberId:entries.number.id,recipients:[entries.person.id],amountCents:50,flowRevision:'1',policyRevision:'owner-only-v1',content:'Confirm the appointment / Confirmar la cita'}
  await page.getByLabel('Grant ID',{exact:true}).fill(grant.id)
  await page.getByLabel('Proposed state JSON').fill(JSON.stringify(state))
  await page.getByRole('button',{name:'Review proposed work',exact:true}).click();await proof('exact-work-review')
  await page.getByRole('checkbox',{name:'I approve this exact reviewed work'}).check()
  await page.getByRole('button',{name:'Approve exact work',exact:true}).click()
  await page.getByRole('heading',{name:'Exact approval recorded',exact:true}).waitFor();await proof('approval-receipt')
  const approval=(await page.locator('main > p').allTextContents()).join(' ').match(/Approval ([a-f0-9-]{36})/)[1]
  const held=await post(runtime,'/api/handset/application/prepare',{state,approvalId:approval,idempotencyKey:'synthetic-handset-browser-300'},{authorization:'Bearer '+token})
  assert.equal(held.status,202,await held.clone().text())
  await page.goto(runtime.origin+'/app/grants');await proof('held-work')
  await page.getByRole('button',{name:'Revoke Browser receptionist',exact:true}).click()
  await page.waitForURL(runtime.origin+'/app/grants');await proof('revoked-grant')
  assert.equal((await post(runtime,'/api/handset/application/prepare',{state,idempotencyKey:'synthetic-handset-browser-301'},{authorization:'Bearer '+token})).status,401)
  await page.getByRole('link',{name:'MCP owner consent',exact:true}).click();await proof('mcp-consent')
  await page.goto(runtime.origin+'/app/sources');await proof('empty-sources')
  await page.getByLabel('Twilio account SID',{exact:true}).fill('synthetic-handset-600')
  await page.getByLabel('Selected native business-number record ID').fill(entries.number.id)
  await page.getByRole('checkbox',{name:'I authorize signed inbound communication records for this account and number'}).check()
  await page.getByRole('button',{name:'Authorize inbound records',exact:true}).click()
  await page.getByRole('heading',{name:'Source authorized',exact:true}).waitFor();await proof('source-consent-receipt')
  const source=await sourceFixture(runtime)
  const received=await source.callback({AccountSid:'synthetic-handset-600',To:'+15125550142',CallSid:'synthetic-handset-601',CallStatus:'ringing',SequenceNumber:'0',Timestamp:new Date().toUTCString()})
  assert.equal(received.status,200,await received.clone().text())
  await page.goto(runtime.origin+'/app/cases/'+(await received.json()).caseId);await proof('verified-source-timeline')
  await page.goto(runtime.origin+'/app/sources');await proof('active-sources')
  await page.goto(runtime.origin+'/app/cases?q=synthetic-handset-no-match');await proof('no-matches')
  const member='synthetic-handset-2'
  await runtime.sql("UPDATE oa_operators SET status='active' WHERE id=?",member)
  const memberSession=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  const [memberName,...memberValue]=memberSession.cookie.split('=')
  await context.clearCookies();await context.addCookies([{name:memberName,value:memberValue.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
  await page.goto(runtime.origin+'/app/cases');await page.getByRole('alert').waitFor();await proof('permission-denied')
  assert.ok(!(await page.locator('body').innerText()).includes('Austin service'))
  await page.goto(runtime.origin+'/app/grants');await page.getByRole('alert').waitFor();await proof('grants-permission-denied')
  await page.goto(runtime.origin+'/app/audit');await page.getByRole('alert').waitFor();await proof('audit-permission-denied')
  await page.goto(runtime.origin+'/app/sources');await page.getByRole('alert').waitFor();await proof('sources-permission-denied')
 }finally{await context.close();await browser.close();await runtime.close()}
})

for(const width of [1440,390])test(`Explicit executive delegation and owner-attested playback forms retain truthful end states at ${width}`,async()=>{
 const {delegationFixture,recordingFixture}=await import('./helpers/handset-delegation.mjs')
 const runtime=await openHandset({twilio:true}),browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage(),evidence=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-workspace'
 await mkdir(evidence,{recursive:true})
 async function as(cookie){const [name,...value]=cookie.split('=');await context.clearCookies();await context.addCookies([{name,value:value.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])}
 async function proof(name){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name);await page.screenshot({path:`${evidence}/${width}-${name}.png`,fullPage:true})}
 try{
  const owner=await signIn(runtime);await as(owner.cookie)
  await page.goto(runtime.origin+'/app/front-desk');await proof('empty-front-desk')
  const f=await delegationFixture(runtime),media=await recordingFixture(runtime,f)
  await page.reload();await proof('owner-line-policy')
  await page.getByLabel('Selected line ID',{exact:true}).fill(f.line.id)
  await page.getByLabel('Assistant operator ID',{exact:true}).fill('synthetic-handset-2')
  await page.getByLabel('Delegation expiry (UTC)',{exact:true}).fill(new Date(Date.now()+1800000).toISOString().slice(0,16))
  await page.getByRole('checkbox',{name:'I approve this exact assistant and executive line',exact:true}).check()
  await page.getByRole('button',{name:'Grant call controls',exact:true}).click();await page.waitForLoadState('load')
  await as(f.principal.cookie);await page.goto(runtime.origin+'/app/front-desk')
  await page.getByLabel('My availability',{exact:true}).selectOption('busy');await page.getByRole('button',{name:'Update my presence',exact:true}).click();await page.waitForLoadState('load')
  await as(f.assistant.cookie);await page.goto(runtime.origin+'/app/front-desk')
  assert.ok((await page.locator('main').innerText()).includes('busy'));await proof('assistant-busy-lamp')
  for(const kind of ['pickup','park','transfer','callback']){
   const action=page.getByLabel('Call action / Acción',{exact:true});await action.focus()
   await action.press('Home');for(let i=0;i<['pickup','park','transfer','callback'].indexOf(kind);i++)await action.press('ArrowDown')
   assert.equal(await action.inputValue(),kind)
   await page.getByLabel('Line call',{exact:true}).selectOption(f.callId)
   if(['transfer','callback'].includes(kind))await page.getByLabel('Transfer operator ID or callback phone / Destino',{exact:true}).fill(kind==='transfer'?'synthetic-handset-700':'+15125550180')
   const submit=page.getByRole('button',{name:'Review call request / Revisar solicitud',exact:true});await submit.focus();await submit.press('Enter')
   await page.getByRole('heading',{name:'Call request held / Solicitud pendiente',exact:true}).waitFor();await proof('held-'+kind)
   assert.ok((await page.getByRole('status').innerText()).includes('No call effect occurred'))
   await page.getByRole('link',{name:'Return to front desk',exact:true}).click()
  }
  await proof('assistant-principal-history')
  await page.goto(runtime.origin+'/app/recordings');await proof('recording-no-implicit-grant')
  assert.ok((await page.locator('main').innerText()).includes('No current recording approvals'))
  await as(f.cookie);await page.goto(runtime.origin+'/app/recordings');await proof('owner-recording-consent')
  await page.getByLabel('Provider recording',{exact:true}).selectOption(media.recordingId)
  await page.getByLabel('Exact approved person',{exact:true}).selectOption('synthetic-handset-2')
  await page.getByLabel('Recording approval expiry (UTC)',{exact:true}).fill(new Date(Date.now()+1800000).toISOString().slice(0,16))
  await page.getByRole('checkbox',{name:'I attest participant consent and approve playback for this exact person',exact:true}).check()
  await page.getByRole('button',{name:'Approve recording playback',exact:true}).click()
  await page.getByRole('heading',{name:'Recording approval recorded',exact:true}).waitFor();await proof('recording-consent-receipt')
  await as(f.assistant.cookie);await page.goto(runtime.origin+'/app/recordings');await proof('approved-recording')
  await page.getByRole('link',{name:'Play approved recording '+media.recordingId,exact:true}).click()
  await page.getByRole('heading',{name:'Owner-attested exact-person playback',exact:true}).waitFor();await proof('recording-player')
  assert.equal(await page.locator('audio').getAttribute('preload'),'none')
  const response=await context.request.get(runtime.origin+'/api/handset/recordings/'+media.recordingId+'/playback');assert.equal(response.status(),200);assert.deepEqual(Buffer.from(await response.body()),media.bytes)
  await as(f.cookie);await page.goto(runtime.origin+'/app/audit');await proof('audit-recording-and-principal')
  const desk=await (await runtime.request('/api/handset/front-desk',{headers:f.assistantHeaders})).json()
  for(const d of desk.lines){await post(runtime,'/api/handset/front-desk/revoke',{delegationId:d.delegation_id},f.headers)}
  await as(f.assistant.cookie);await page.goto(runtime.origin+'/app/front-desk');await proof('revoked-delegation')
  assert.ok((await page.locator('main').innerText()).includes('No delegated executive lines'))
  const refused=await post(runtime,'/api/handset/front-desk/operations',f.operation,f.assistantHeaders);assert.equal(refused.status,403)
  await page.goto(runtime.origin+'/app/recordings');const g=(await runtime.sql('SELECT id FROM hnd_recording_grants')).results[0]
  await post(runtime,'/api/handset/recordings/grants/'+g.id+'/revoke',{},f.headers)
  await page.reload();await proof('revoked-recording')
  await page.goto(runtime.origin+'/app/front-desk/lines');await page.getByRole('alert').waitFor();await proof('front-desk-invalid-door')
 }finally{await context.close();await browser.close();await runtime.close()}
})

for(const width of [1440,390])test(`Executive inbound routing and suspended source reconsent at ${width}`,async()=>{
 const {inboundFixture}=await import('./helpers/handset-inbound.mjs'),{mailLink}=await import('./helpers/handset-auth.mjs')
 const runtime=await openHandset({twilio:true}),browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage(),evidence=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-workspace'
 await mkdir(evidence,{recursive:true})
 async function as(cookie){const [name,...value]=cookie.split('=');await context.clearCookies();await context.addCookies([{name,value:value.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])}
 async function proof(name){
  const overflow=await page.evaluate(()=>[...document.querySelectorAll('main *')].map(el=>({tag:el.tagName,classes:el.className,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width,display:getComputedStyle(el).display})).filter(el=>el.right>innerWidth+1||el.left<0))
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${name}: ${JSON.stringify(overflow)}`)
  await page.screenshot({path:`${evidence}/${width}-${name}.png`,fullPage:true})
 }
 try{
  const f=await inboundFixture(runtime);await f.policy({dnd:1});await as(f.cookie)
  await page.goto(runtime.origin+'/app/front-desk');await proof('executive-routing-approved')
  await page.getByLabel('Existing consent-qualified voicemail URL',{exact:true}).fill(f.voicemail)
  await page.getByLabel('Exact assistant grant for DND coverage',{exact:true}).selectOption(f.currentGrant.id)
  const consent=page.getByRole('checkbox',{name:'I approve this exact inbound coverage, voicemail and forwarding, including carrier charges',exact:true})
  await consent.check();const submit=page.getByRole('button',{name:'Approve inbound routing',exact:true});await submit.focus();await submit.press('Enter');await page.waitForLoadState('load')
  assert.ok((await f.expectRoute('dnd_assistant')).includes('>'+f.endpoint+'</Sip>'))
  await proof('executive-routing-saved')
  await f.create('front-desk/lines',{...f.lineInput,id:f.line.id,revision:f.currentLine.revision,dnd:1})
  await page.reload();assert.ok((await page.locator('main').innerText()).includes('Line changed — approve again'));await proof('executive-routing-stale')
  assert.equal((await f.carrier()).status,409)
  await page.goto(runtime.origin+'/app/audit');await page.getByText('frontdesk.route · uncertain',{exact:true}).waitFor();await proof('audit-applied-revisions')
  // A second owner changes the actual consenting person's authority, then
  // performs fresh explicit consent through the same browser source form.
  assert.equal((await post(runtime,'/auth/invite',{email:'synthetic-handset-795@example.test',displayName:'Marisol Vega / Operations',role:'owner'},f.headers)).status,202)
  const invite=mailLink(runtime.mails.at(-1)),joined=await post(runtime,'/auth/confirm',{token:invite.searchParams.get('token')});assert.equal(joined.status,303)
  const reviewer=joined.headers.get('set-cookie').split(';')[0]
  assert.equal((await post(runtime,'/auth/operator/status',{operatorId:'synthetic-handset-1',status:'inactive'},{cookie:reviewer})).status,200)
  await as(reviewer);await page.goto(runtime.origin+'/app/sources');await proof('source-authority-suspended')
  assert.ok((await page.locator('main').innerText()).includes('Suspended'))
  await page.getByLabel('Twilio account SID',{exact:true}).fill(f.account)
  await page.getByLabel('Selected native business-number record ID',{exact:true}).fill(f.numberId)
  await page.getByRole('checkbox',{name:'I authorize signed inbound communication records for this account and number',exact:true}).check()
  await page.getByRole('button',{name:'Authorize inbound records',exact:true}).click();await page.getByRole('heading',{name:'Source authorized',exact:true}).waitFor();await proof('source-reconsent-receipt')
  await page.getByRole('link',{name:'Review sources',exact:true}).click();await proof('source-current-and-suspended-history')
  const active=(await (await runtime.request('/api/handset/sources',{headers:{cookie:reviewer}})).json()).sources.find(s=>s.status==='active')
  await page.getByRole('button',{name:'Revoke source '+active.id,exact:true}).click();await page.getByRole('heading',{name:'Source revoked',exact:true}).waitFor();await proof('source-revoked-receipt')
  await page.getByRole('link',{name:'Review sources',exact:true}).click()
  await page.getByLabel('Twilio account SID',{exact:true}).fill(f.account)
  await page.getByLabel('Selected native business-number record ID',{exact:true}).fill(f.numberId)
  await page.getByRole('checkbox',{name:'I authorize signed inbound communication records for this account and number',exact:true}).check()
  await page.getByRole('button',{name:'Authorize inbound records',exact:true}).click()
  await page.getByRole('heading',{name:'Source authorized',exact:true}).waitFor()
  await page.getByRole('link',{name:'Review sources',exact:true}).click();await proof('source-reconsent-after-revocation')
  const renewed=(await (await runtime.request('/api/handset/sources',{headers:{cookie:reviewer}})).json()).sources
  assert.equal(renewed.find(s=>s.id===active.id).status,'revoked')
  assert.ok(renewed.some(s=>s.status==='active'&&s.number_id===f.numberId&&s.revision>active.revision))
 }finally{await context.close();await browser.close();await runtime.close()}
})

for(const width of [1440,390])test(`Reviewed front desk call execution and provider observations at ${width}`,async()=>{
 const {controlFixture}=await import('./helpers/handset-delegation.mjs')
 const runtime=await openHandset({twilio:true}),browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage(),evidence=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-workspace'
 await mkdir(evidence,{recursive:true})
 async function as(cookie){const [name,...value]=cookie.split('=');await context.clearCookies();await context.addCookies([{name,value:value.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])}
 async function proof(name){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name);await page.screenshot({path:`${evidence}/${width}-${name}.png`,fullPage:true})}
 try{
  const f=await controlFixture(runtime)
  for(const kind of ['pickup','park','transfer','callback']){
   let list
   if(kind==='callback')list=await f.makeList({count:1,mode:'preview',repId:f.q.spanish})
   if(kind!=='park')await f.ready(kind==='transfer'?f.q.english:f.q.spanish)
   const provider=kind==='callback'?f.prepare(list):null
   await as(f.assistant.cookie);await page.goto(runtime.origin+'/app/front-desk')
   await page.getByLabel('Call action / Acción',{exact:true}).selectOption(kind)
   if(kind!=='callback')await page.getByLabel('Line call',{exact:true}).selectOption(f.callId)
   if(kind==='transfer'||kind==='callback')await page.getByLabel('Transfer operator ID or callback phone / Destino',{exact:true}).fill(kind==='transfer'?f.q.english:list.recipients[0].recipient)
   const request=page.getByRole('button',{name:'Review call request / Revisar solicitud',exact:true});await request.focus();await request.press('Enter')
   await page.getByRole('heading',{name:'Call request held / Solicitud pendiente',exact:true}).waitFor()
   const desk=await (await runtime.request(f.base,{headers:f.assistantHeaders})).json(),op=desk.operations.find(o=>o.kind===kind)
   assert.ok(op)
   await as(f.cookie);await page.goto(runtime.origin+'/app/front-desk');await proof('review-'+kind)
   await page.getByLabel('Call request ID',{exact:true}).fill(op.id)
   if(list)await page.getByLabel('Qualified single callback list ID (callback only)',{exact:true}).fill(list.id)
   await page.getByLabel('Exact call approval expiry (UTC, within five minutes)',{exact:true}).fill(new Date(Date.now()+240000).toISOString().slice(0,16))
   await page.getByRole('checkbox',{name:'I approve this exact existing call move or single callback',exact:true}).check()
   await page.getByRole('button',{name:'Approve exact call request',exact:true}).click();await page.waitForLoadState('load')
   await as(f.assistant.cookie);await page.goto(runtime.origin+'/app/front-desk')
   const execute=page.getByRole('button',{name:'Execute approved request '+op.id,exact:true});await execute.focus();await execute.press('Enter')
   await page.getByRole('heading',{name:'Call control observation',exact:true}).waitFor()
   assert.match(await page.getByRole('status').innerText(),/outcome uncertain/);await proof('executed-'+kind)
   if(provider){const attempts=(await f.read()).attempts.filter(a=>a.recipient===list.recipients[0].recipient);assert.equal(attempts.length,1);await f.connect(attempts[0],provider)}
   await page.getByRole('link',{name:'Return to front desk',exact:true}).click()
   const reconcile=page.getByRole('button',{name:'Reconcile request '+op.id,exact:true});await reconcile.focus();await reconcile.press('Enter')
   await page.getByRole('heading',{name:'Call control observation',exact:true}).waitFor()
   assert.match(await page.getByRole('status').innerText(),/Provider membership observed/);assert.ok((await page.locator('main').innerText()).includes('No completed customer outcome is claimed'));await proof('observed-'+kind)
  }
 }finally{await context.close();await browser.close();await runtime.close()}
})

for(const width of [1440,390])test(`Exact-person audit read and export approvals and immediate revocation at ${width}`,async()=>{
 const runtime=await openHandset(),browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage(),evidence=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-workspace'
 await mkdir(evidence,{recursive:true})
 async function as(cookie){const [name,...value]=cookie.split('=');await context.clearCookies();await context.addCookies([{name,value:value.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])}
 async function proof(name){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name);await page.screenshot({path:`${evidence}/${width}-${name}.png`,fullPage:true})}
 try{
  const owner=await signIn(runtime),headers={cookie:owner.cookie}
  assert.equal((await post(runtime,'/auth/operator/status',{operatorId:'synthetic-handset-2',status:'active'},headers)).status,200)
  const reader=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  assert.equal((await post(runtime,'/api/handset/cases',{title:'Austin service follow-up',promise:'Call after the replacement arrives',dueAt:Date.now()+86400000},headers)).status,201)
  async function grant(exporting){
   await as(owner.cookie);await page.goto(runtime.origin+'/app/audit')
   const inventory=await (await runtime.request('/api/handset/audit/access',{headers})).json(),person=inventory.people.find(p=>p.id==='synthetic-handset-2')
   await page.getByLabel('Exact audit reader',{exact:true}).selectOption(person.id+':'+person.version)
   await page.getByLabel('Audit access expiry (UTC, within one day)',{exact:true}).fill(new Date(Date.now()+1800000).toISOString().slice(0,16))
   if(exporting)await page.getByRole('checkbox',{name:'Allow audit export',exact:true}).check()
   await page.getByRole('checkbox',{name:'I approve installation audit access for this exact person',exact:true}).check()
   await proof(exporting?'audit-export-approval':'audit-read-approval')
   await page.getByRole('button',{name:'Grant audit access',exact:true}).click();await page.getByRole('heading',{name:'Audit access granted',exact:true}).waitFor()
   await proof(exporting?'audit-export-granted':'audit-read-granted')
   const current=await (await runtime.request('/api/handset/audit/access',{headers})).json()
   return current.access.find(g=>g.person_id===person.id&&Boolean(g.allow_export)===exporting)
  }
  const readOnly=await grant(false)
  await as(reader.cookie);await page.goto(runtime.origin+'/app/audit');await page.getByRole('heading',{name:'Accountable audit',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Grant audit access',exact:true}).count(),0)
  assert.equal(await page.getByRole('button',{name:'Anonymize audit identity',exact:true}).count(),0)
  assert.equal((await context.request.get(runtime.origin+'/api/handset/audit/export')).status(),403)
  await proof('audit-read-only-person')
  await grant(true)
  await as(reader.cookie);await page.goto(runtime.origin+'/app/audit');await page.getByRole('heading',{name:'Accountable audit',exact:true}).waitFor()
  assert.equal((await context.request.get(runtime.origin+'/api/handset/audit/export')).status(),200);await proof('audit-export-person')
  await as(owner.cookie);await page.goto(runtime.origin+'/app/audit')
  await page.getByRole('button',{name:'Revoke audit access '+readOnly.id,exact:true}).click();await page.getByRole('heading',{name:'Audit access revoked',exact:true}).waitFor();await proof('audit-access-revoked')
  await as(reader.cookie);await page.goto(runtime.origin+'/app/audit');await page.getByRole('alert').waitFor();await proof('audit-revoked-person')
  assert.equal((await context.request.get(runtime.origin+'/api/handset/audit/export')).status(),403)
 }finally{await context.close();await browser.close();await runtime.close()}
})

for(const width of [1440,390])test(`Assigned number-scoped teammate case work and source reconsent at ${width}`,async()=>{
 const runtime=await openHandset({twilio:true}),browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage(),evidence=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-workspace'
 await mkdir(evidence,{recursive:true})
 async function as(cookie){const [name,...value]=cookie.split('=');await context.clearCookies();await context.addCookies([{name,value:value.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])}
 async function proof(name){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name);await page.screenshot({path:`${evidence}/${width}-${name}.png`,fullPage:true})}
 try{
  const f=await sourceFixture(runtime),native=await recordsFixture(runtime,f.cookie)
  assert.equal((await post(runtime,'/auth/operator/status',{operatorId:'synthetic-handset-2',status:'active'},f.headers)).status,200)
  const worker=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  assert.equal((await post(runtime,'/api/handset/cases/'+native.caseId,{title:native.detail.current.title,ownerId:'synthetic-handset-2',version:1,promise:native.detail.current.promise,dueAt:native.detail.current.due_at},f.headers)).status,200)
  await as(worker.cookie);await page.goto(runtime.origin+'/app/cases/'+native.caseId);await page.getByRole('alert').waitFor();await proof('number-work-before-grant')
  await as(f.cookie);await page.goto(runtime.origin+'/app/sources')
  const inventory=await (await runtime.request('/api/handset/sources/access',{headers:f.headers})).json(),person=inventory.people.find(p=>p.id==='synthetic-handset-2')
  await page.getByLabel('Exact number worker',{exact:true}).selectOption(person.id+':'+person.version)
  await page.getByLabel('Selected native number record ID',{exact:true}).selectOption(native.entries.number.id)
  await page.getByLabel('Number access expiry (UTC, within one day)',{exact:true}).fill(new Date(Date.now()+1800000).toISOString().slice(0,16))
  await page.getByRole('checkbox',{name:'I approve case work and inbound source consent for this exact person and number',exact:true}).check();await proof('number-work-approval')
  await page.getByRole('button',{name:'Grant number work',exact:true}).click();await page.getByRole('heading',{name:'Number work granted',exact:true}).waitFor();await proof('number-work-granted')
  const access=(await (await runtime.request('/api/handset/sources/access',{headers:f.headers})).json()).access.find(g=>g.person_id===person.id&&g.number_id===native.entries.number.id)
  await as(worker.cookie);await page.goto(runtime.origin+'/app/cases')
  assert.equal(await page.getByRole('button',{name:'Save case / Guardar caso',exact:true}).count(),0)
  await page.getByRole('link',{name:native.detail.current.title,exact:true}).click();await proof('number-work-assigned-case')
  await page.getByLabel('Case title / Asunto',{exact:true}).fill('Scoped replacement callback / Seguimiento')
  await page.getByRole('button',{name:'Save case / Guardar caso',exact:true}).click();await page.getByRole('heading',{name:'Scoped replacement callback / Seguimiento',exact:true}).waitFor()
  await page.getByLabel('Comment',{exact:true}).fill('Confirmar la cita; delivery remains uncertain')
  await page.getByRole('button',{name:'Add comment',exact:true}).click();await page.waitForLoadState('load');await proof('number-work-comment')
  const current=await (await runtime.request('/api/handset/cases/'+native.caseId,{headers:f.headers})).json()
  assert.equal((await post(runtime,'/api/handset/cases/'+native.caseId,{title:'Owner reviewed the callback',ownerId:'synthetic-handset-2',version:current.current.version,promise:current.current.promise,dueAt:current.current.due_at},f.headers)).status,200)
  await page.getByLabel('Case title / Asunto',{exact:true}).fill('Stale teammate edit')
  await page.getByRole('button',{name:'Save case / Guardar caso',exact:true}).click();await page.getByRole('alert').filter({hasText:'Another teammate'}).waitFor();await proof('number-work-conflict')
  async function consent(){
   await page.getByLabel('Twilio account SID',{exact:true}).fill(f.account)
   await page.getByLabel('Selected native business-number record ID',{exact:true}).fill(native.entries.number.id)
   await page.getByRole('checkbox',{name:'I authorize signed inbound communication records for this account and number',exact:true}).check()
   await page.getByRole('button',{name:'Authorize inbound records',exact:true}).click();await page.getByRole('heading',{name:'Source authorized',exact:true}).waitFor()
   await page.getByRole('link',{name:'Review sources',exact:true}).click()
  }
  await page.goto(runtime.origin+'/app/sources');await consent();await proof('number-work-source-consent')
  const source=(await (await runtime.request('/api/handset/sources',{headers:{cookie:worker.cookie}})).json()).sources.find(s=>s.status==='active')
  await page.getByRole('button',{name:'Revoke source '+source.id,exact:true}).click();await page.getByRole('heading',{name:'Source revoked',exact:true}).waitFor()
  await page.getByRole('link',{name:'Review sources',exact:true}).click();await consent();await proof('number-work-source-reconsent')
  await as(f.cookie);await page.goto(runtime.origin+'/app/sources')
  await page.getByRole('button',{name:'Revoke number work '+access.id,exact:true}).click();await page.getByRole('heading',{name:'Number work revoked',exact:true}).waitFor();await proof('number-work-revoked')
  await page.getByRole('link',{name:'Review sources',exact:true}).click();assert.ok((await page.locator('main').innerText()).includes('Suspended'));await proof('number-work-suspended-source')
  await as(worker.cookie);await page.goto(runtime.origin+'/app/cases/'+native.caseId);await page.getByRole('alert').waitFor();await proof('number-work-revoked-person')
  assert.equal((await context.request.get(runtime.origin+'/api/handset/sources')).status(),403)
 }finally{await context.close();await browser.close();await runtime.close()}
})
