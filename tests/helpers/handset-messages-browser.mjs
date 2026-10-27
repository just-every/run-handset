import assert from 'node:assert/strict'
import { post } from './handset-auth.mjs'
import { messagesFixture } from './handset-messages.mjs'

export async function messageJourney({runtime,page,context,cookie,proof,click}) {
 await page.goto(runtime.origin+'/app/messages'); await proof('messages-empty')
 assert.match(await page.locator('main').innerText(),/No conversations yet/)
 const f=await messagesFixture(runtime),headers={cookie}
 await f.incoming('Please help with my order')
 const snapshot=async()=>await (await runtime.request('/api/handset/messages',{headers})).json()
 const thread=(await snapshot()).threads.find(t=>t.peer===f.recipient)
 assert.ok(thread)
 await page.goto(runtime.origin+'/app/messages?thread='+encodeURIComponent(thread.id)); await proof('messages-inbox')
 assert.match(await page.locator('main').innerText(),/Please help with my order/)
 await click('Claim conversation'); await proof('messages-claimed')
 await page.goto(runtime.origin+'/app/messages/settings')
 await page.getByLabel('Snippet name',{exact:true}).fill('Order follow-up')
 await page.getByLabel('Snippet text',{exact:true}).fill('We will check your order and follow up.')
 await click('Save snippet')
 await page.getByLabel('Recipient',{exact:true}).fill(f.recipient)
 await page.getByLabel('Evidence of explicit permission',{exact:true}).fill('Customer requested a customer-care text during the call')
 await page.getByLabel('Permission expires at (UTC)',{exact:true}).fill(new Date(f.now+30*86400000).toISOString().slice(0,16))
 await page.getByRole('checkbox',{name:'I verified explicit permission for customer-care texts'}).check()
 await click('Record permission')
 await page.goto(runtime.origin+'/app/messages?thread='+encodeURIComponent(thread.id))
 await page.getByLabel('Due at (UTC)',{exact:true}).fill(new Date(f.now+86400000).toISOString().slice(0,16))
 await click('Create scheduled draft'); await proof('messages-draft')
 assert.match(await page.locator('main').innerText(),/We will check your order and follow up/)
 await page.getByRole('checkbox',{name:/I reviewed and approve the exact scheduled message/}).check()
 await click('Queue exact message'); await proof('messages-queued')
 assert.match(await page.locator('main').innerText(),/queued/)
 await click('Hand off to HappyToHelp'); await proof('messages-custody')
 assert.match(await page.locator('main').innerText(),/happytohelp/)
 await click('Reclaim for handset')
 // A stale revision is refused while the visible form retains its submitted values.
 const current=(await snapshot()).threads.find(t=>t.id===thread.id)
 const changed=await post(runtime,`/api/handset/messages/threads/${thread.id}/claim`,{revision:current.revision},headers)
 assert.ok(changed.ok,await changed.clone().text())
 await click('Claim conversation'); await page.getByRole('alert').waitFor(); await proof('messages-denied')
 assert.match(await page.getByRole('alert').innerText(),/Submitted revision/)
 await f.incoming('STOP')
 await page.goto(runtime.origin+'/app/messages?thread='+encodeURIComponent(thread.id)); await proof('messages-suppressed')
 assert.match(await page.locator('main').innerText(),/Suppressed/)
 assert.equal((await runtime.request('/api/handset/messages')).status,401)
 assert.equal(await page.getByRole('button').evaluateAll(buttons=>buttons.every(b=>b.textContent.trim().length>2)),true)
 void context
}
