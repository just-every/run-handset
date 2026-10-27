import assert from 'node:assert/strict'
import { numberFixture } from './handset-numbers.mjs'

export async function numbersJourney({runtime,page,cookie,proof,click}){
 const f=await numberFixture(runtime,cookie),url=runtime.origin+'/app/numbers'
 const submit=async name=>{const received=page.waitForResponse(r=>r.request().method()==='POST');await click(name);return (await received).status()}
 async function search(kind='local'){
  await page.goto(url);const searchPanel=page.locator('main details');if(!await searchPanel.getAttribute('open').then(v=>v!==null))await searchPanel.locator('summary').click()
  await page.getByLabel('Twilio account SID',{exact:true}).fill(f.account)
  await page.getByLabel('Number type',{exact:true}).selectOption(kind)
  await page.getByLabel('Area code',{exact:true}).fill(kind==='local'?'512':'833')
  await click('Search numbers')
 }
 async function buy(phone){
  const article=page.getByRole('article').filter({has:page.getByRole('heading',{name:phone,exact:true})}),form=article.locator('form')
  await form.getByLabel('Company, location, team or person assignment',{exact:true}).fill('Austin · Equipo de atención')
  await form.getByLabel('Purpose',{exact:true}).fill('Appointments · Citas')
  await form.getByRole('checkbox').check();await click('Buy '+phone)
 }
 await page.goto(url);await proof('numbers-empty')
 assert.match(await page.locator('main').innerText(),/No purchased numbers/)
 f.setEmpty(true);await search();assert.match(await page.locator('main').innerText(),/No matching numbers/);await proof('numbers-no-results');f.setEmpty(false)
 await search();assert.match(await page.locator('main').innerText(),/USD 1.15 per month/);await proof('numbers-quote',page.getByRole('article').first())
 await buy('+15125550125');assert.match(await page.locator('main').innerText(),/owned/);await proof('numbers-owned',page.locator('[data-number]').first())
 f.setUncertain(true);await search('tollfree');await buy('+18335550125');assert.match(await page.locator('main').innerText(),/purchase may have completed/);await proof('numbers-uncertain',page.locator('[data-number]').filter({has:page.getByRole('heading',{name:'+18335550125',exact:true})}))
 await click('Read purchase outcome');f.setUncertain(false)
 assert.equal((await f.inventory()).filter(n=>n.state==='owned').length,2)
 const first=(await f.inventory()).find(n=>n.e164==='+15125550125'),replacement=(await f.inventory()).find(n=>n.e164==='+18335550125')
 const card=()=>page.locator(`[data-number="${first.id}"]`)
 await card().getByLabel('Reviewed replacement number',{exact:true}).selectOption(replacement.id+':'+replacement.revision)
 await card().getByRole('checkbox').check();await click('Review release '+first.e164)
 assert.match(await card().innerText(),/Review hold until/);assert.match(await card().innerText(),/within 10 days/);await proof('numbers-review-hold',card())
 await card().getByRole('checkbox').check();assert.equal(await submit('Release '+first.e164),409)
 await page.getByRole('alert').waitFor();await proof('numbers-held-refusal')
 await page.goto(url)
 const current=(await f.inventory()).find(n=>n.id===first.id)
 await f.value(await f.send('/'+first.id+'/cancel',{revision:current.revision}))
 await card().getByRole('checkbox').check();assert.equal(await submit('Release '+first.e164),409)
 await page.getByRole('alert').waitFor();await proof('numbers-stale')
 await page.goto(url)
 await card().getByLabel('Reviewed replacement number',{exact:true}).selectOption(replacement.id+':'+replacement.revision)
 await card().getByRole('checkbox').check();await click('Review release '+first.e164)
 const reviewed=(await f.inventory()).find(n=>n.id===first.id)
 await runtime.setTime(reviewed.hold_until+1)
 await card().getByRole('checkbox').check();await click('Release '+first.e164)
 assert.match(await card().innerText(),/Carrier confirmed release/);await proof('numbers-released',card())
 assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1)
 await page.goto(url);await page.locator('main details summary').click();await page.getByLabel('Twilio account SID',{exact:true}).fill('synthetic-handset-7999');assert.equal(await submit('Search numbers'),503)
 await page.getByRole('alert').waitFor();await proof('numbers-provider-failed')
}
