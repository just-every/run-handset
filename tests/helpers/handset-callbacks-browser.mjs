import assert from 'node:assert/strict'
import { post } from './handset-auth.mjs'
import { queueFixture } from './handset-queues.mjs'
import { sourceFixture } from './handset-sources.mjs'

export async function callbackJourney({ runtime, page, proof, cookie }) {
 const source = await sourceFixture(runtime), f = await queueFixture(runtime, source.cookie), headers = { cookie }
 const click = async name => { await page.getByRole('button', { name, exact: true }).first().click(); await page.waitForLoadState('load') }
 await page.goto(runtime.origin + '/app/callbacks'); await proof('callbacks-empty')
 assert.match(await page.locator('main').innerText(), /Callers hear no virtual hold offer/)
 await page.getByText('Approve or change the callback policy', { exact: true }).click()
 await page.getByLabel('Staff number to ring', { exact: true }).fill('+15125550777'); await page.getByLabel('Business name spoken to callers', { exact: true }).fill('Cedar Creek Heating')
 await page.getByLabel('Queue', { exact: true }).selectOption({ label: 'Sales / Ventas' })
 await page.getByRole('checkbox').check(); await click('Save callback policy')
 assert.match(await page.locator('main').innerText(), /Rings staff at\s*\+15125550777/); await proof('callbacks-policy')
 // An owned missed call, a reviewed recipient window and an owner-scheduled callback the customer asked for.
 const missed = await (await source.callback({ From: '+15125552001', CallSid: 'synthetic-handset-missed-1', CallStatus: 'no-answer', SequenceNumber: '0', Timestamp: new Date().toISOString() })).json()
 const created = await post(runtime, '/api/handset/recovery', { callRecordId: missed.recordId, dueAt: Date.now() + 86400000, maxAttempts: 2 }, headers); assert.equal(created.status, 201, await created.clone().text())
 const owner = (await runtime.sql("SELECT version FROM oa_operators WHERE id='synthetic-handset-1'")).results[0]
 await runtime.sql('INSERT INTO hnd_text_recipients VALUES (?,?,?,?,?,?,?)', '+15125552001', 'America/Chicago', 480, 1260, 'synthetic-handset-1', owner.version, Date.now() + 86400000 * 30)
 await page.goto(runtime.origin + '/app/callbacks')
 await page.getByLabel('Evidence the customer asked', { exact: true }).fill('The customer asked on the shared thread for a call back')
 await page.getByRole('checkbox', { name: 'The customer asked for this callback', exact: true }).check(); await click('Schedule callback')
 assert.match(await page.locator('main').innerText(), /waiting · \+15125552001 · scheduled/); await proof('callbacks-scheduled')
 await page.getByLabel('Evidence note', { exact: true }).fill('Mara spoke with the customer by phone'); await click('Cancel callback')
 assert.match(await page.locator('main').innerText(), /cancelled · \+15125552001/); await proof('callbacks-cancelled')
 assert.equal((await (await runtime.request('/api/handset/callbacks', { headers })).json()).callbacks[0].state, 'cancelled')
 void f
}
