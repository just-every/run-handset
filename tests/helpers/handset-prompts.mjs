import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { openHandset } from './handset-worker.mjs'
import { sourceFixture } from './handset-sources.mjs'
import { post } from './handset-auth.mjs'

export const business = '+18335550125'
export const instants = { open: '2026-11-03T16:00:00Z', closed: '2026-11-07T16:00:00Z', holiday: '2026-11-26T16:00:00Z' }

/** A PCM16 WAV tone: the shape a browser recorder or an uploaded file has before normalization. */
export function wavBytes({ rate = 44100, channels = 1, seconds = 1, freq = 440 } = {}) {
 const frames = Math.round(rate * seconds), data = Buffer.alloc(frames * channels * 2)
 for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 12000), (i * channels + c) * 2)
 const head = Buffer.alloc(44)
 head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(channels, 22)
 head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * channels * 2, 28); head.writeUInt16LE(channels * 2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40)
 return Buffer.concat([head, data])
}
export const b64 = bytes => Buffer.from(bytes).toString('base64')

export async function promptFixture(options = {}) {
 const speech = []
 const runtime = await openHandset({
  twilio: true,
  ttsEdge: async (request, Response) => {
   const body = await request.json()
   speech.push({ headers: Object.fromEntries(request.headers), body })
   return new Response(wavBytes({ rate: 24000, seconds: 1.5, freq: body.input.includes('Hola') || body.input.includes('cerrado') ? 330 : 520 }), { status: 200, headers: { 'content-type': 'audio/wav' } })
  },
  ...options,
 })
 try {
  const source = await sourceFixture(runtime, { e164: business }), headers = source.headers
  const ok = async (method, path, value, status = 200) => {
   const response = method === 'GET' ? await runtime.request(path, { headers }) : await post(runtime, path, value, headers)
   assert.equal(response.status, status, path + ' ' + await response.clone().text())
   return response.json()
  }
  const refused = async (path, value, status, code) => {
   const response = await post(runtime, path, value, headers)
   assert.equal(response.status, status, path + ' ' + await response.clone().text())
   if (code) assert.equal((await response.json()).error, code)
  }
  async function signed(path, fields, { signature = true, account = source.account } = {}) {
   const data = { AccountSid: account, ...fields }
   let payload = runtime.origin + path
   for (const key of Object.keys(data).sort()) payload += key + data[key]
   return runtime.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signature ? { 'x-twilio-signature': createHmac('sha1', 'synthetic-handset-500').update(payload).digest('base64') } : {}) }, body: new URLSearchParams(data).toString() })
  }
  return { runtime, source, headers, speech, ok, refused, signed }
 } catch (error) { await runtime.close(); throw error }
}
export async function newPrompt(f, name, purpose, shared = false) { return f.ok('POST', '/api/handset/prompts', { name, purpose, shared }, 201) }
export async function approve(f, versionId) {
 const v = (await f.ok('GET', '/api/handset/prompts')).versions.find(x => x.id === versionId)
 await f.ok('POST', `/api/handset/prompts/versions/${versionId}/preview`, { audioSha256: v.audio_sha256 })
 return f.ok('POST', `/api/handset/prompts/versions/${versionId}/approve`, { audioSha256: v.audio_sha256, confirm: 'approve this exact prompt version' })
}

export const people = [
 { id: 'synthetic-handset-1', extension: '101', name: 'Mara Patel', destination: '+15125550142' },
 { id: 'synthetic-handset-610', extension: '102', name: 'Rosa García', destination: '+15125550143' },
 { id: 'synthetic-handset-611', extension: '103', name: 'Ana Garcia-Lopez', destination: '+15125550144' },
]
export async function registerPeople(f) {
 for (const p of people.slice(1)) await f.runtime.sql('INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES (?,?,?,?,?,?)', p.id, p.id + '@example.test', p.name, 'member', 'active', Date.now())
 for (const p of people) await f.ok('POST', '/api/handset/prompts/extensions', { extension: p.extension, operatorId: p.id, directoryName: p.name, destination: p.destination }, 201)
}
export async function queueId(f) {
 return (await f.ok('POST', '/api/handset/queues', { name: 'Sales', mode: 'longest_idle', skills: [], maxWaitSeconds: 120, wrapSeconds: 30, maxWaiting: 100, overflowKind: 'voicemail', confirm: 'approve native queue policy' }, 201)).id
}
export const flowDefinition = (queue, pins) => ({
 name: 'Business reception', entry: 'hours', timezone: 'America/Chicago', overrides: [{ date: '2026-11-26', entry: 'holiday' }],
 nodes: [
  { id: 'hours', kind: 'hours', next: ['open', 'closed'], hours: { weekly: [{ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 }] } },
  { id: 'open', kind: 'menu', next: ['sales', 'closed'], prompt: pins.greeting },
  { id: 'sales', kind: 'queue', next: [], queueId: queue, prompt: pins.queue },
  { id: 'closed', kind: 'receptionist', next: [], language: 'es', prompt: pins.closed },
  { id: 'holiday', kind: 'end', next: [], prompt: pins.holiday },
 ],
})
export const coverage = [['hours', 'open', 'sales'], ['hours', 'open', 'closed'], ['hours', 'closed'], ['holiday']]
export async function publishFlow(f, definition, previous = null, revision = 0) {
 const draft = await f.ok('POST', '/api/handset/flows', { definition, ...(previous ? { flowId: previous.flowId, previousVersionId: previous.id } : {}) }, 201)
 for (const path of coverage) await f.ok('POST', `/api/handset/flows/${draft.id}/test`, { path })
 await f.ok('POST', `/api/handset/flows/${draft.id}/publish`, { revision, confirm: 'approve this exact tested flow version' })
 return draft
}
/** Four approved prompts (upload, upload, Spanish speech, upload), four extensions and a published flow that pins them. */
export async function authoredFlow(f) {
 await registerPeople(f)
 const queue = await queueId(f), pins = {}
 for (const [key, name, purpose, source, language, variant] of [['greeting', 'Main greeting', 'main_attendant', 'upload', 'en', 'business_hours'], ['queue', 'Queue wait', 'queue', 'upload', 'en', 'always'], ['closed', 'After hours', 'after_hours', 'tts', 'es', 'after_hours'], ['holiday', 'Holiday', 'holiday', 'upload', 'en', 'holiday']]) {
  const prompt = await newPrompt(f, name, purpose, key === 'greeting')
  const body = source === 'tts' ? { source, language, variant, script: 'Hola, estamos cerrados. Llámenos mañana.' } : { source, language, variant, audioBase64: b64(wavBytes({ rate: 22050, seconds: 1 })) }
  const version = await f.ok('POST', `/api/handset/prompts/${prompt.id}/versions`, body, 201)
  await approve(f, version.id)
  pins[key] = { promptId: prompt.id, versionId: version.id }
 }
 const flow = await publishFlow(f, flowDefinition(queue, pins))
 return { queue, pins, flow }
}
