import { signIn } from './handset-auth.mjs'
import assert from 'node:assert/strict'
import { sourceFixture } from './handset-sources.mjs'
import { queueFixture, queueProviderFixture } from './handset-queues.mjs'

export async function queueMediaJourney({runtime,page,proof,cookie}){
 const url=runtime.origin+'/app/queues/media'
 const click=async(button)=>{await button.click();await page.waitForLoadState('load')}
 await page.goto(url);await proof('queue-media-empty')
 const source=await sourceFixture(runtime),f=await queueFixture(runtime,cookie)
 const destinations={
  [f.english]:'sip:synthetic-handset-611@synthetic-handset-612.example.test',
  [f.spanish]:'sip:synthetic-handset-613@synthetic-handset-614.example.test',
 }
 const state=await f.read(),name=id=>state.agents.find(a=>a.operator_id===id).display_name
 const section=title=>page.locator('section').filter({has:page.getByRole('heading',{name:title,exact:true})})
 await page.goto(url);await proof('queue-media-unqualified')
 for(const [operatorId,destination] of Object.entries(destinations)){
  const form=section(name(operatorId))
  await form.getByLabel('Approved inbound source',{exact:true}).selectOption(source.source.id)
  await form.getByLabel('Destination type',{exact:true}).selectOption('sip')
  await form.getByLabel('Exact Client identity or SIP URI',{exact:true}).fill(destination)
  await form.getByRole('checkbox').check()
  await click(form.getByRole('button',{name:'Approve agent route',exact:true}))
  await page.waitForURL(url)
 }
 const overflow=section('Sales / Ventas · voicemail')
 await overflow.getByLabel('Exact existing HTTPS TwiML route',{exact:true}).fill('https://synthetic-handset-620.example.test/voicemail')
 await overflow.getByRole('checkbox').check()
 await click(overflow.getByRole('button',{name:'Approve overflow route',exact:true}));await page.waitForURL(url)
 await proof('queue-media-approved')
 const route=(await f.read()).agentRoutes.find(r=>r.operator_id===f.english)
 await f.write(f.base+'/agents/'+f.english+'/route',{sourceId:source.source.id,kind:'sip',destination:route.destination,revision:route.revision,confirm:'approve exact queue agent route'})
 await section(name(f.english)).getByRole('checkbox').check()
 await click(section(name(f.english)).getByRole('button',{name:'Approve agent route',exact:true}))
 await page.getByRole('alert').waitFor();await proof('queue-media-stale-refusal')
 await page.goto(runtime.origin+'/app/queues/settings')
 const bindingForm=page.locator('form').filter({has:page.getByRole('button',{name:'Authorize signed inbound queue routing',exact:true})})
 await bindingForm.getByLabel('Approved inbound source',{exact:true}).selectOption(source.source.id)
 await bindingForm.getByLabel('Queue',{exact:true}).selectOption(f.sales.id)
 await click(bindingForm.getByRole('button',{name:'Authorize signed inbound queue routing',exact:true}))
 const binding=(await f.read()).bindings[0]
 const edge=queueProviderFixture(runtime,source,{...binding,callbackPath:'/providers/twilio/queues/'+binding.id})
 const call={...edge.resource(70),Digits:'2'},instructions=await edge.callback(call)
 assert.equal(instructions.status,200);assert.ok((await instructions.text()).includes('>'+destinations[f.spanish]+'</Sip>'))
 let offer=(await f.read()).offers[0]
 await page.goto(url);await proof('queue-media-uncertain')
 const sid=edge.child(70,call,destinations[f.spanish],'in-progress',{date_created:new Date().toUTCString(),start_time:new Date().toUTCString()})
 await click(page.getByRole('button',{name:'Read current provider outcome',exact:true}));await page.waitForURL(url)
 assert.equal((await f.read()).entries.find(e=>e.id===offer.entry_id).state,'active')
 await proof('queue-media-connected')
 await page.goto(runtime.origin+'/app/queues')
 const sales=section('Sales / Ventas')
 const rosa=sales.locator('li').filter({hasText:'Rosa García'}).filter({has:page.getByRole('button',{name:'Log out of Sales / Ventas',exact:true})})
 await click(rosa.getByRole('button',{name:'Log out of Sales / Ventas',exact:true}))
 assert.equal((await f.read()).entries.find(e=>e.id===offer.entry_id).state,'active')
 await proof('queue-media-logout-keeps-call')
 await page.goto(url)
 await click(section(name(f.spanish)).getByRole('button',{name:'Revoke new calls to '+name(f.spanish),exact:true}))
 assert.equal((await f.read()).entries.find(e=>e.id===offer.entry_id).state,'active')
 await proof('queue-media-revoked-active')
 edge.child(70,call,destinations[f.spanish],'in-progress',{parent_call_sid:'synthetic-handset-999'})
 await click(page.getByRole('button',{name:'Read current provider outcome',exact:true}));await page.getByRole('alert').waitFor()
 await proof('queue-media-readback-refusal')
 edge.child(70,call,destinations[f.spanish],'completed')
 const recovered=await page.goto(url)
 assert.equal(recovered.status(),200,await page.locator('main').innerText())
 await click(page.getByRole('button',{name:'Read current provider outcome',exact:true}));await page.waitForURL(url)
 offer=(await f.read()).offers.find(o=>o.id===offer.id)
 assert.equal(offer.state,'completed');assert.equal(offer.child_call_sid,sid)
 await proof('queue-media-completed')
 await runtime.sql("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES ('synthetic-handset-619','synthetic-handset-619@example.test','Casey Rivera','owner','active',?)",Date.now())
 await runtime.sql("UPDATE oa_operators SET role='member',version=version+1 WHERE id=?",f.english)
 const replacement=(await signIn({...runtime,ownerEmail:'synthetic-handset-619@example.test'})).cookie
 const [key,...value]=replacement.split('=')
 await page.context().clearCookies();await page.context().addCookies([{name:key,value:value.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
 await page.goto(url);assert.ok((await page.locator('main').innerText()).includes('Suspended — approver no longer authorized'));await proof('queue-media-suspended-approver')
}
