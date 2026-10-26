import assert from 'node:assert/strict'
import { sourceFixture } from './handset-sources.mjs'
import { business, people, wavBytes } from './handset-prompts.mjs'

export const speechEdge = async (request, Response) => new Response(wavBytes({ rate: 24000, seconds: 1.5, freq: 330 }), { status: 200, headers: { 'content-type': 'audio/wav' } })

export async function promptJourney({ runtime, page, proof, cookie }) {
 const author = page.locator('form[data-prompt-author]'), phone = page.locator('form[action="/app/prompts/phone-recordings"]')
 const click = async name => { await page.getByRole('button', { name, exact: true }).first().click(); await page.waitForLoadState('load') }
 const source = await sourceFixture(runtime, { e164: business })
 await page.goto(runtime.origin + '/app/prompts'); await proof('prompts-empty')
 for (const [name, use] of [['Main greeting', 'main attendant'], ['Queue wait', 'queue']]) {
  const form = page.locator('form[action="/app/prompts"]')
  await form.getByLabel('Name', { exact: true }).fill(name); await form.getByLabel('Use', { exact: true }).selectOption({ label: use })
  if (name === 'Main greeting') await form.getByRole('checkbox').check()
  await click('Create prompt')
 }
 const ext = page.locator('form[action="/app/prompts/extensions"]')
 await ext.getByLabel('Person', { exact: true }).selectOption({ label: people[0].name }); await ext.getByLabel('Extension', { exact: true }).fill('101')
 await ext.getByLabel('Directory name', { exact: true }).fill(people[0].name); await ext.getByLabel('Rings this number', { exact: true }).fill(people[0].destination); await click('Save extension')
 assert.match(await page.locator('main').innerText(), /101 · Mara Patel/)
 // Upload: an invalid file is refused, a WAV file becomes a draft in the carrier format.
 await author.getByLabel('Prompt', { exact: true }).selectOption({ label: 'Main greeting' }); await author.getByLabel('Source', { exact: true }).selectOption('upload')
 await author.getByLabel('Audio file', { exact: true }).setInputFiles({ name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(300, 7) }); await click('Add version')
 await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /unsupported audio format/); await proof('prompts-invalid-file-refused')
 await author.getByLabel('Prompt', { exact: true }).selectOption({ label: 'Main greeting' }); await author.getByLabel('Source', { exact: true }).selectOption('upload')
 await author.getByLabel('Schedule variant', { exact: true }).selectOption({ label: 'business hours' })
 await author.getByLabel('Audio file', { exact: true }).setInputFiles({ name: 'greeting.wav', mimeType: 'audio/wav', buffer: wavBytes({ rate: 44100, channels: 2, seconds: 1 }) }); await click('Add version')
 assert.match(await page.locator('main').innerText(), /upload · English · business hours/)
 // Browser microphone: the recorder produces a WAV the server normalizes.
 await author.getByLabel('Prompt', { exact: true }).selectOption({ label: 'Queue wait' }); await author.getByLabel('Source', { exact: true }).selectOption('browser_recording')
 await page.getByRole('button', { name: 'Start recording', exact: true }).click(); await page.waitForTimeout(1200)
 await page.getByRole('button', { name: 'Stop recording', exact: true }).click(); await page.getByLabel('Recording preview', { exact: true }).waitFor({ state: 'visible' })
 await proof('prompts-microphone-recorded'); await click('Add version')
 assert.match(await page.locator('main').innerText(), /browser recording · English/)
 // Spanish text to speech through the speech edge.
 await author.getByLabel('Prompt', { exact: true }).selectOption({ label: 'Queue wait' }); await author.getByLabel('Source', { exact: true }).selectOption('tts')
 await author.getByLabel('Language', { exact: true }).selectOption({ label: 'Spanish' }); await author.getByLabel('Greeting text', { exact: true }).fill('Gracias por esperar. Un agente le atenderá pronto.'); await click('Add version')
 assert.match(await page.locator('main').innerText(), /tts · Spanish/)
 // Preview, then approve the exact version.
 assert.equal(await page.getByRole('button', { name: 'Approve this exact version', exact: true }).count(), 0, 'no approval before preview')
 await click('Mark previewed'); await proof('prompts-previewed'); await click('Approve this exact version')
 assert.match(await page.locator('main').innerText(), /Approved\. Flows pin this exact version/); await proof('prompts-approved')
 // Record by phone gives a one-time code for the author's own number; any other number is refused.
 await phone.getByLabel('Your registered number', { exact: true }).fill('+15125559999'); await click('Request recording call')
 await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /unauthorized record destination/)
 await phone.getByLabel('Your registered number', { exact: true }).fill(people[0].destination); await click('Request recording call')
 assert.match(await page.getByRole('status').last().innerText(), /One-time code \d{6}/); await proof('prompts-phone-code')
 const listing = await (await runtime.request('/api/handset/prompts', { headers: { cookie } })).json()
 assert.deepEqual(listing.versions.map(v => v.source).sort(), ['browser_recording', 'tts', 'upload'])
 assert.equal(listing.recordings.length, 1)
 void source
}
