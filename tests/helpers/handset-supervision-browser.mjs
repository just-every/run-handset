import assert from 'node:assert/strict'
import { post } from './handset-auth.mjs'
import { metricConfig } from './handset-metrics.mjs'
import { supervisionFixture } from './handset-supervision.mjs'

export async function supervisionJourney({runtime,page,context,cookie,proof,click}){
 const root=runtime.origin+'/app/supervision'
 await page.goto(root);assert.match(await page.locator('main').innerText(),/No current queue supervision grants/);await proof('supervision-empty')
 const f=await supervisionFixture(runtime,cookie)
 await page.goto(root+'/settings');await proof('supervision-permissions')
 for(const queue of [f.sales,f.support]){
  await page.getByLabel('Supervisor',{exact:true}).selectOption(f.english)
  await page.getByLabel('Queue team',{exact:true}).selectOption(queue.id)
  await page.getByLabel('Agent state intervention',{exact:true}).selectOption('true')
  await page.getByRole('checkbox',{name:'I approve this exact supervision scope',exact:true}).check()
  await click('Grant supervision scope')
 }
 await proof('supervision-permissions-current')
 await page.goto(root);assert.equal(await page.getByRole('link',{name:f.sales.name,exact:true}).count(),1)
 await proof('supervision-queues')
 const board=root+'/queues/'+f.sales.id
 const entry=await f.admit(f.sales,'en');await f.write(f.queueBase+'/'+f.sales.id+'/dispatch',{});await f.action(entry.id,'accept')
 await page.goto(board)
 const metrics=page.locator('#supervision-metrics'),value=async(label)=>metrics.locator('dt').filter({hasText:new RegExp('^'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}).evaluate(el=>el.nextElementSibling.textContent)
 assert.equal(await value('Service level'),'40.00% (2 of 5)')
 assert.equal(await value('Average speed of answer (seconds)'),'17.5 (70 of 4)')
 assert.equal(await value('Eligible abandonment'),'20.00% (1 of 5)')
 assert.equal(await value('Mean eligible abandon wait (seconds)'),'40 (40 of 1)')
 assert.equal(await value('Average handled time (seconds)'),'60 (240 of 4)')
 for(const [label,expected] of Object.entries({offered:6,arrivals:6,transfers:0,overflows:0,callbacks:0,answered:4,abandoned:2,'eligible Abandons':1,'short Abandons':1,'within Target':2,'completed Handled':4,'talk Seconds':160,'hold Seconds':40,'wrap Seconds':40})){
  assert.equal(await value(label),String(expected),'reviewed queue '+label)
 }
 assert.deepEqual(await metrics.locator('li').allTextContents(),Array.from({length:6},(_,index)=>'synthetic-handset-entry-'+(index+1)),'exact known source legs appear on the wallboard')
 const agentMeasures=page.locator('#supervision-live article').filter({has:page.getByRole('heading',{name:f.english,exact:true})})
 const agentValues=await agentMeasures.locator('dl').evaluate(dl=>Object.fromEntries([...dl.querySelectorAll('dt')].map(dt=>[dt.textContent,dt.nextElementSibling.textContent])))
 assert.deepEqual(agentValues,{'Occupancy':'40.00% (240 of 600)','Staffed seconds':'600','Logged-in seconds':'630','Answered offers':'4','Missed offers':'1',available:'200',ringing:'60',talk:'160',hold:'40',wrap:'40',unavailable:'100',break:'30','logged-out':'60'},'rendered agent offers, staffing and durations reconcile with known legs')
 const text=await page.locator('main').innerText()
 for(const expected of ['40.00% (240 of 600)','600','160','40','synthetic-handset-entry-1','synthetic-handset-entry-6'])assert.ok(text.includes(expected),expected)
 assert.equal(text.includes(f.dataset.entries[0].callId),false,'no caller record identity in wallboard')
 await proof('supervision-current')
 const form=page.locator('form[data-supervision-action]').filter({has:page.locator('input[name="revision"]')}).first()
 await form.getByLabel('Set availability',{exact:true}).selectOption('away');await form.getByLabel('Reason',{exact:true}).fill('Coaching break requested')
 await form.getByRole('button',{name:'Apply agent state',exact:true}).click();await page.waitForLoadState('load')
 assert.match(await page.locator('#supervision-live').innerText(),/Mara Patel.*away/)
 assert.match(await page.locator('#supervision-live').innerText(),/Mara Patel.*available → away.*Coaching break requested/)
 assert.equal((await f.read('/queues/'+f.sales.id)).live.active,1)
 await proof('supervision-agent-unavailable')
 const availableForm=page.locator('form[data-supervision-action]').first()
 await availableForm.getByLabel('Set availability',{exact:true}).selectOption('available');await availableForm.getByLabel('Reason',{exact:true}).fill('Coaching completed')
 await availableForm.getByRole('button',{name:'Apply agent state',exact:true}).click();await page.waitForLoadState('load')
 assert.match(await page.locator('#supervision-live').innerText(),/away → available.*Coaching completed/)
 await proof('supervision-agent-restored')
 // Start both displays below the target, then change the native threshold.
 // Measure actual browser visibility independently of the application's clock.
 let revision=(await f.read('/queues/'+f.sales.id)).metrics.config.revision
 assert.equal((await post(runtime,'/api/handset/metrics/config',metricConfig(f.sales.id,revision,{targetSeconds:120}),{cookie})).status,201)
 await page.goto(board)
 const tv=await context.newPage();await tv.goto(board+'/tv')
 try{
  assert.equal(await page.locator('[data-breach="true"]').count(),0);assert.equal(await tv.locator('[data-breach="true"]').count(),0)
  const started=performance.now()
  assert.equal((await post(runtime,'/api/handset/metrics/config',metricConfig(f.sales.id,revision+1),{cookie})).status,201)
  await Promise.all([page.locator('[data-breach="true"]').waitFor({timeout:10000}),tv.locator('[data-breach="true"]').waitFor({timeout:10000})])
  const visibleMs=performance.now()-started
  assert.ok(visibleMs<10000,'service-level breach reaches both displays within ten seconds')
  console.log(JSON.stringify({journey:'supervision-breach',width:page.viewportSize().width,visibleMs}))
  await proof('supervision-breach')
  const retained=await metrics.innerText()
  const interrupt='**/app/supervision/queues/*/live'
  await context.route(interrupt,route=>route.abort())
  await Promise.all([page.locator('#supervision-freshness').filter({hasText:'Stale'}).waitFor(),tv.locator('#supervision-freshness').filter({hasText:'Stale'}).waitFor()])
  assert.equal(await metrics.innerText(),retained,'interrupted updates retain the actual observed measures')
  assert.ok((await tv.locator('#supervision-metrics').innerText()).includes('40.00% (2 of 5)'))
  assert.equal(await page.getByRole('button',{name:'Apply agent state',exact:true}).first().isDisabled(),true)
  await proof('supervision-stale-retained')
  await context.unroute(interrupt)
  await page.locator('#supervision-freshness').filter({hasText:'Live'}).waitFor()
  await proof('supervision-reconnected')
  // A real native waiting entry crosses a fixed target without changing that
  // target. Only the isolated Worker clock advances; browser elapsed time does not.
  revision=(await f.read('/queues/'+f.sales.id)).metrics.config.revision
  assert.equal((await post(runtime,'/api/handset/metrics/config',metricConfig(f.sales.id,revision,{targetSeconds:60}),{cookie})).status,201)
  const waiting=await f.admit(f.sales,'en'),queuedAt=Date.now()
  await Promise.all([page.goto(board),tv.goto(board+'/tv')])
  assert.equal(await page.locator('[data-breach="true"]').count(),0)
  assert.equal(await tv.locator('[data-breach="true"]').count(),0)
  const waitStarted=performance.now()
  await runtime.setTime(queuedAt+61000)
  await Promise.all([page.locator('[data-breach="true"]').waitFor({timeout:10000}),tv.locator('[data-breach="true"]').waitFor({timeout:10000})])
  const waitingVisibleMs=performance.now()-waitStarted
  assert.ok(waitingVisibleMs<10000,'a native waiting breach reaches supervisor and TV within ten seconds')
  for(const display of [page,tv]){
   const now=display.locator('#supervision-live section').filter({has:display.getByRole('heading',{name:'Queue now',exact:true})})
   const values=await now.locator('dl').evaluate(dl=>Object.fromEntries([...dl.querySelectorAll('dt')].map(dt=>[dt.textContent,dt.nextElementSibling.textContent])))
   assert.equal(values.Waiting,'1');assert.equal(values['Waiting entries past answer target'],'1')
   assert.equal(values['Reviewed entries past answer target'],'0');assert.equal(values['Active calls'],'1')
  }
  assert.equal((await f.queueRead()).entries.find(e=>e.id===waiting.id).state,'waiting')
  console.log(JSON.stringify({journey:'supervision-native-wait-breach',width:page.viewportSize().width,visibleMs:waitingVisibleMs}))
  await proof('supervision-native-wait-breach')
  await context.route(interrupt,route=>route.abort())
  const retainedAgent=await agentMeasures.innerText(),retainedTv=await tv.locator('#supervision-metrics').innerText()
  await Promise.all([page.locator('#supervision-freshness').filter({hasText:'Stale'}).waitFor(),tv.locator('#supervision-freshness').filter({hasText:'Stale'}).waitFor()])
  assert.equal(await agentMeasures.innerText(),retainedAgent,'update loss retains agent durations and occupancy')
  assert.equal(await tv.locator('#supervision-metrics').innerText(),retainedTv,'TV retains all source measures instead of healthy zeros')
  await proof('supervision-native-wait-stale')
  await context.unroute(interrupt)
 }finally{await tv.close()}
 await page.goto(board+'/tv');assert.equal(await page.locator('form[data-supervision-action]').count(),0);await proof('supervision-tv')
 await page.goto(board)
 const scopes=(await f.read()).grants.filter(g=>g.queue_id===f.sales.id&&g.operator_id===f.english)
 for(const grant of scopes)await f.send('/grants/'+grant.id+'/revoke',{})
 await page.locator('#supervision-freshness').filter({hasText:'Access unavailable'}).waitFor()
 assert.equal(await page.locator('#supervision-metrics').count(),0,'revoked authority clears retained data')
 assert.equal(await page.locator('form[data-supervision-action]').count(),0)
 assert.equal((await page.locator('main').innerText()).includes('Mara Patel'),false,'revocation removes agent names from control cards as well as live values')
 await proof('supervision-revoked')
 const foreignCookie=await f.personSession(f.spanish),[name,...parts]=foreignCookie.split('=')
 await context.clearCookies();await context.addCookies([{name,value:parts.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
 const denied=await page.goto(board);assert.equal(denied.status(),403);assert.equal(await page.locator('#supervision-metrics').count(),0);await proof('supervision-denied')
}
