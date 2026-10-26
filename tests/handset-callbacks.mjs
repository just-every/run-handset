import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { post } from './helpers/handset-auth.mjs'
import { openHandset } from './helpers/handset-worker.mjs'
import { sourceFixture } from './helpers/handset-sources.mjs'
import { authorizeQueueMedia, queueFixture } from './helpers/handset-queues.mjs'

const business = '+15125550125', staff = '+15125550777'
const callbackClock = Date.parse('2026-10-26T18:00:00Z')

async function setup(options = {}) {
 const runtime = await openHandset({ twilio: true, ...options }), source = await sourceFixture(runtime), f = await queueFixture(runtime, source.cookie)
 const media = await authorizeQueueMedia(f, source), placed = [], create = { drop: false, reject: false }
 runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${source.account}/Calls.json`, async request => {
  const form = Object.fromEntries(new URLSearchParams(await request.text()))
  assert.equal(form.From, business); assert.match(form.To, /^\+[1-9]\d{7,14}$/)
  placed.push(form)
  if (create.reject) return { code: 21211, message: 'Synthetic invalid number', __httpStatus: 400 }
  const sid = `synthetic-handset-out-${placed.length}`
  source.resource('Calls', sid, { direction: 'outbound-api', from: form.From, to: form.To, status: 'queued', date_created: new Date().toUTCString() })
  if (create.drop) { create.drop = false; throw new Error('synthetic-handset-lost-response') }
  return { sid, __httpStatus: 201 }
 })
 const api = async (path, value, status = 201) => { const r = await post(runtime, path, value, f.headers); assert.equal(r.status, status, path + ' ' + await r.clone().text()); return r.json() }
 const read = async path => (await runtime.request(path, { headers: f.headers })).json()
 const state = () => read('/api/handset/callbacks')
 async function signed(path, fields, { signature = true } = {}) {
  const data = { AccountSid: source.account, ...fields }
  let payload = runtime.origin + path
  for (const key of Object.keys(data).sort()) payload += key + data[key]
  return runtime.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signature ? { 'x-twilio-signature': createHmac('sha1', 'synthetic-handset-500').update(payload).digest('base64') } : {}) }, body: new URLSearchParams(data).toString() })
 }
 const owner = (await runtime.sql("SELECT version FROM oa_operators WHERE id='synthetic-handset-1'")).results[0]
 const review = (recipient, startMinute = 0, endMinute = 1440) => runtime.sql('INSERT OR REPLACE INTO hnd_text_recipients VALUES (?,?,?,?,?,?,?)', recipient, 'America/Chicago', startMinute, endMinute, 'synthetic-handset-1', owner.version, Date.now() + 86400000 * 30)
 const approve = () => api('/api/handset/callbacks/policies', { sourceId: source.source.id, queueId: f.sales.id, staffTarget: staff, businessName: 'Cedar Creek Heating', maxAttempts: 2, retrySeconds: 900, confirm: 'approve caller-requested callbacks' })
 const tick = (at = Date.now()) => runtime.scheduled(at)
 // The attempt's answer, key press and staff leg are signed carrier requests against the placed call.
 const attempt = index => {
  const form = placed[index], sid = `synthetic-handset-out-${index + 1}`, path = new URL(form.Url).pathname
  const fields = { CallSid: sid, From: business, To: form.To, Direction: 'outbound-api' }
  return { form, sid, path, fields, answer: () => signed(path, { ...fields, CallStatus: 'in-progress' }), press: digits => signed(path + '/choice', { ...fields, CallStatus: 'in-progress', Digits: digits }),
   end: status => { source.resource('Calls', sid, { direction: 'outbound-api', from: business, to: form.To, status, date_created: new Date().toUTCString() }); return signed(path + '/status', { ...fields, CallStatus: status }) },
   staff: (childStatus, extra = {}) => { const child = `synthetic-handset-leg-${index + 1}`; source.resource('Calls', child, { parent_call_sid: sid, from: business, to: staff, direction: 'outbound-dial', status: childStatus, ...(childStatus === 'completed' ? { duration: '42' } : {}), ...extra }); return { child, outcome: (fields2 = {}) => signed(path + '/outcome', { ...fields, DialCallSid: child, DialCallStatus: childStatus, ...fields2 }) } } }
 }
 return { runtime, source, f, media, placed, create, api, read, state, signed, review, approve, tick, attempt }
}

test('Virtual hold keeps the retained place and calls each consenting caller back once, in order, with open outcomes never resolved', async () => {
 const t = await setup()
 try {
  const { runtime, f, media, source } = t, edge = media.edge
  for (const agent of [f.english, f.spanish]) await f.presence(agent, 'busy')
  const arrive = async index => { const call = edge.resource(index); const response = await edge.callback(call); assert.equal(response.status, 200, await response.clone().text()); return { call, twiml: await response.text() } }
  // Without an approved policy a waiting caller hears no offer and nothing changes.
  const before = await arrive(90); assert.doesNotMatch(before.twiml, /callbacks\/holds/)
  await t.api('/api/handset/callbacks/policies', { sourceId: source.source.id, queueId: f.sales.id, staffTarget: staff, businessName: 'Cedar Creek Heating', confirm: 'yes' }, 403)
  await t.approve()
  const callers = {}
  for (const [name, index] of [['A', 1], ['B', 2], ['C', 3], ['E', 4], ['F', 5], ['G', 6]]) callers[name] = await arrive(index)
  assert.match(callers.A.twiml, /<Gather input="dtmf" numDigits="1"[^>]*>.*press 1/s)
  // Queue position is set by arrival, not by when a caller presses 1.
  const at = Date.now()
  for (const [name, offset] of [['A', 60000], ['B', 50000], ['C', 40000], ['E', 30000], ['F', 20000], ['G', 10000]]) await runtime.sql('UPDATE hnd_queue_entries SET queued_at=? WHERE call_id IN (SELECT record_id FROM hnd_source_objects WHERE external_id=?)', at - offset, callers[name].call.CallSid)
  const holdPath = name => new URL(callers[name].twiml.match(/action="([^"]*callbacks\/holds[^"]*)"/)[1].replaceAll('&amp;', '&')).pathname
  const press = (name, digits = '1', extra = {}) => t.signed(holdPath(name), { ...callers[name].call, Digits: digits, ...extra })
  assert.equal((await press('G', '2')).status, 200); assert.equal((await t.state()).callbacks.length, 0, 'another key keeps the caller in line')
  assert.equal((await t.signed(holdPath('G'), { ...callers.G.call, Digits: '1' }, { signature: false })).status, 403)
  assert.equal((await press('G', '1', { From: '+15125559999' })).status, 403, 'the key press must come from the queued call')
  for (const name of ['C', 'A', 'B', 'E', 'F']) { const r = await press(name); assert.equal(r.status, 200, await r.clone().text()); assert.match(await r.text(), /keeping your place[\s\S]*<Hangup\/>/) }
  assert.equal((await press('A')).status, 200); let state = await t.state()
  assert.equal(state.callbacks.length, 5, 'a replayed key press never adds a second callback')
  // The caller left the line, but the callback keeps its exact queue place and consent record.
  const entry = (await f.read()).entries.find(e => e.id === (state.callbacks.find(c => c.recipient === callers.A.call.From)).queue_entry_id)
  assert.equal(entry.state, 'abandoned'); assert.equal(entry.reason, 'virtual_hold')
  assert.deepEqual(state.callbacks.map(c => c.recipient), ['A', 'B', 'C', 'E', 'F'].map(n => callers[n].call.From))
  assert.deepEqual(state.callbacks.map(c => c.ahead), [0, 1, 2, 3, 4])
  const consent = JSON.parse(state.callbacks[0].consent)
  assert.deepEqual([consent.kind, consent.digits, consent.purpose, consent.marketingEnrollment, consent.caller, consent.business, consent.callSid, consent.promptVersion], ['dtmf', '1', 'callback', false, callers.A.call.From, business, callers.A.call.CallSid, 'virtual-hold-v1'])
  assert.match(consent.prompt, /press 1/)
  const recoveries = await t.read('/api/handset/recovery'); assert.equal(recoveries.cases.length, 5); assert.ok(recoveries.cases.every(r => r.state === 'open' && r.owner_id === 'synthetic-handset-1'))
  for (const name of ['A', 'B', 'C', 'F']) await t.review(callers[name].call.From)
  // No agent is free: nothing is dialed. One agent frees up: exactly one call, to the earliest place.
  await t.tick(); assert.equal(t.placed.length, 0)
  await runtime.sql("UPDATE hnd_queue_entries SET state='abandoned',ended_at=?,reason='caller_hung_up' WHERE state IN ('waiting','reserved')", Date.now())
  await f.presence(f.english, 'available')
  await t.tick(); assert.equal(t.placed.length, 1); assert.equal(t.placed[0].To, callers.A.call.From)
  assert.equal(new URL(t.placed[0].Url).pathname.startsWith('/providers/twilio/callbacks/attempts/'), true)
  await t.tick(); await runtime.restart(); await t.tick(); assert.equal(t.placed.length, 1, 'replayed ticks and a restart never dial the claimed attempt again')
  // A answers, presses 1 and speaks with staff: only the verified staff leg completes the callback.
  const a = t.attempt(0)
  assert.equal((await t.signed(a.path, a.fields, { signature: false })).status, 403)
  source.resource('Calls', 'synthetic-handset-foreign', { direction: 'outbound-api', from: business, to: '+15125559999', status: 'in-progress' })
  assert.equal((await t.signed(a.path, { ...a.fields, CallSid: 'synthetic-handset-foreign' })).status, 403)
  assert.match(await (await a.answer()).text(), /you asked for a call back/)
  const dial = await (await a.press('1')).text(); assert.match(dial, new RegExp(`<Number>\\${staff}</Number>`))
  const wrongLeg = a.staff('completed', { to: '+15125550888' }); assert.equal((await wrongLeg.outcome()).status, 403)
  state = await t.state(); assert.equal(state.callbacks[0].state, 'dialing'); assert.equal((await t.read('/api/handset/recovery')).cases.find(r => r.case_id === state.callbacks[0].case_id).state, 'open')
  const spoke = a.staff('completed'); assert.equal((await spoke.outcome()).status, 200)
  state = await t.state(); assert.equal(state.callbacks.find(c => c.recipient === callers.A.call.From).state, 'completed')
  const resolved = (await t.read('/api/handset/recovery')).cases.find(r => r.recipient === callers.A.call.From)
  assert.equal(resolved.state, 'resolved'); assert.equal(JSON.parse(resolved.resolution).conversation.duration, 42)
  assert.equal((await spoke.outcome()).status, 200); assert.equal(t.placed.length, 1, 'a replayed staff outcome neither dials nor reopens')
  // B is next in place; the customer declines by keypad and is never called again.
  await t.tick(); assert.equal(t.placed.length, 2); assert.equal(t.placed[1].To, callers.B.call.From)
  const b = t.attempt(1); await b.answer(); assert.match(await (await b.press('2')).text(), /Goodbye/)
  state = await t.state(); assert.equal(state.callbacks.find(c => c.recipient === callers.B.call.From).state, 'declined')
  assert.equal((await t.read('/api/handset/recovery')).cases.find(r => r.recipient === callers.B.call.From).state, 'declined')
  // C's line is busy: the attempt stays an open task and retries later in the same place.
  await t.tick(); assert.equal(t.placed.length, 3); assert.equal(t.placed[2].To, callers.C.call.From)
  const c = t.attempt(2); assert.equal((await c.end('busy')).status, 204)
  state = await t.state(); const retry = state.callbacks.find(x => x.recipient === callers.C.call.From)
  assert.equal(retry.state, 'waiting'); assert.equal(retry.attempts, 1); assert.equal(retry.queued_at, at - 40000, 'the retry keeps the original place')
  assert.equal((await t.read('/api/handset/recovery')).cases.find(r => r.recipient === callers.C.call.From).state, 'open', 'busy never resolves the missed call')
  // STOP suppresses F; E has no reviewed recipient hours so its reason is kept and nothing is dialed.
  await t.api('/api/handset/protection/stops', { numberId: source.numberId, recipient: callers.F.call.From, channel: 'all', reason: 'dnc', confirm: 'record outbound consent stop' })
  await t.tick(); assert.equal(t.placed.length, 3, 'C retries only after its delay; E is held; F is suppressed')
  state = await t.state()
  assert.equal(state.callbacks.find(x => x.recipient === callers.E.call.From).reason, 'recipient_timezone_unknown_or_expired')
  assert.equal(state.callbacks.find(x => x.recipient === callers.F.call.From).state, 'cancelled')
  assert.equal((await t.read('/api/handset/recovery')).cases.find(r => r.recipient === callers.F.call.From).state, 'stopped')
  await t.review(callers.E.call.From)
  await runtime.sql('UPDATE hnd_callbacks SET due_at=? WHERE recipient=?', Date.now() - 1, callers.C.call.From)
  await t.tick(); assert.deepEqual(t.placed.slice(3).map(p => p.To), [callers.C.call.From], 'the earlier retained place dials first on its retry')
  const c2 = t.attempt(3); assert.equal((await c2.end('no-answer')).status, 204)
  state = await t.state(); assert.equal(state.callbacks.find(x => x.recipient === callers.C.call.From).state, 'unanswered', 'the attempt limit leaves an owned open task')
  assert.equal((await t.read('/api/handset/recovery')).cases.find(r => r.recipient === callers.C.call.From).state, 'open')
  await t.tick(); assert.deepEqual(t.placed.slice(4).map(p => p.To), [callers.E.call.From])
  assert.equal(t.placed.filter(p => p.To === callers.A.call.From).length, 1); assert.equal(t.placed.filter(p => p.To === callers.B.call.From).length, 1)
  assert.equal((await runtime.request('/api/handset/callbacks')).status, 401)
 } finally { await t.runtime.close() }
})

test('A scheduled callback honors the recipient hours, survives restart without a second dial and never replays an uncertain create', async () => {
 const t = await setup({ callingClock: true, clockTime: callbackClock })
 try {
  const { runtime, f, source, api } = t
  const missed = async n => {
   const response = await source.callback({ From: `+1512555${String(2000 + n)}`, CallSid: `synthetic-handset-missed-${n}`, CallStatus: 'no-answer', SequenceNumber: '0', Timestamp: new Date().toISOString() })
   assert.equal(response.status, 200, await response.clone().text()); return response.json()
  }
  const open = async n => { const call = await missed(n); return { call, recovery: (await api('/api/handset/recovery', { callRecordId: call.recordId, dueAt: callbackClock + 6 * 3600000, maxAttempts: 2 })).recovery, recipient: `+1512555${String(2000 + n)}` } }
  const [one, two, three] = [await open(1), await open(2), await open(3)], fresh = async () => { await f.presence(f.english, 'available'); await f.presence(f.spanish, 'available') }
  const schedule = (r, dueAt, extra = {}) => api('/api/handset/callbacks', { recoveryId: r.recovery.id, dueAt, evidence: 'The customer asked on the shared inbox thread for a call back', confirm: 'the customer asked for this callback', ...extra })
  await api('/api/handset/callbacks', { recoveryId: one.recovery.id, dueAt: callbackClock + 3600000, evidence: 'x', confirm: 'yes' }, 403)
  assert.equal((await post(runtime, '/api/handset/callbacks', { recoveryId: one.recovery.id, dueAt: callbackClock + 3600000, evidence: 'x', confirm: 'the customer asked for this callback' }, f.headers)).status, 409, 'a callback needs an approved policy')
  await t.approve()
  assert.equal((await post(runtime, '/api/handset/callbacks', { recoveryId: one.recovery.id, dueAt: callbackClock + 3600000, evidence: 'x', confirm: 'the customer asked for this callback' }, f.headers)).status, 409, 'and a reviewed recipient timezone')
  // Recipient hours 08:00-12:00 Chicago; the clock is 13:00 local, the callback is due at 14:00.
  for (const r of [one, two, three]) await t.review(r.recipient, 480, 720)
  const first = (await schedule(one, callbackClock + 3600000)).callback; await schedule(two, callbackClock + 3600000); await schedule(three, callbackClock + 3600000)
  assert.equal((await post(runtime, '/api/handset/callbacks', { recoveryId: one.recovery.id, dueAt: callbackClock + 7200000, evidence: 'again', confirm: 'the customer asked for this callback' }, f.headers)).status, 409)
  assert.equal(JSON.parse(first.consent).kind, 'owner_attested')
  await t.tick(callbackClock); await runtime.restart(); await t.tick(callbackClock); assert.equal(t.placed.length, 0, 'nothing dials before the due time, before or after restart')
  await runtime.setTime(callbackClock + 3600000); await fresh()
  await t.tick(callbackClock + 3600000); assert.equal(t.placed.length, 0)
  assert.equal((await t.state()).callbacks.find(c => c.id === first.id).reason, 'recipient_quiet_hours', 'outside the recipient hours the reason is kept and no call is placed')
  for (const r of [one, two, three]) await t.review(r.recipient, 480, 1020)
  await t.tick(callbackClock + 3600000); assert.equal(t.placed.length, 2, 'two free agents, two callbacks, one attempt each')
  await t.tick(callbackClock + 3600000); await runtime.restart(); await t.tick(callbackClock + 3600000)
  assert.equal(t.placed.length, 2, 'a restart before or after the due attempt never dials twice')
  assert.deepEqual(t.placed.map(p => p.To).sort(), [one.recipient, two.recipient].sort())
  // Cancelling is a documented human decision; the cancelled callback never dials.
  let state = await t.state(); const pending = state.callbacks.find(c => c.recipient === three.recipient)
  const cancelled = await api(`/api/handset/callbacks/${pending.id}/cancel`, { revision: pending.revision, note: 'Mara spoke with the customer by phone' }, 200)
  assert.equal(cancelled.callback.state, 'cancelled'); assert.match(cancelled.callback.reason, /Mara spoke/)
  await api(`/api/handset/callbacks/${pending.id}/cancel`, { revision: pending.revision, note: 'stale' }, 409)
  // An answered callback with a verified conversation resolves its missed call; the other attempt stays open until observed.
  const ranFor = n => t.placed.findIndex(p => p.To === n)
  const talk = t.attempt(ranFor(one.recipient)); await talk.answer(); await talk.press('1'); assert.equal((await talk.staff('completed').outcome()).status, 200)
  state = await t.state(); assert.equal(state.callbacks.find(c => c.recipient === one.recipient).state, 'completed')
  assert.equal(state.callbacks.find(c => c.recipient === two.recipient).state, 'dialing')
  assert.equal((await t.read('/api/handset/recovery')).cases.find(r => r.id === two.recovery.id).state, 'open')
  // After a restart, a callback whose create response was lost is uncertain, is never retried and needs the owner.
  const stay = t.attempt(ranFor(two.recipient)); await stay.answer(); await stay.press('2')
  assert.equal((await t.state()).callbacks.find(c => c.recipient === two.recipient).state, 'declined')
  await runtime.setTime(callbackClock + 7200000); await fresh()
  const four = await open(4); await t.review(four.recipient, 480, 1020); await schedule(four, callbackClock + 7200000)
  t.create.drop = true
  await t.tick(callbackClock + 7200000)
  const lost = (await t.state()).callbacks.find(c => c.recipient === four.recipient); assert.equal(lost.state, 'uncertain')
  const placedBefore = t.placed.length
  await t.tick(callbackClock + 7300000); await runtime.restart(); await t.tick(callbackClock + 7400000)
  assert.equal(t.placed.length, placedBefore, 'an uncertain create is never replayed automatically')
  await runtime.setTime(callbackClock + 7500000)
  await api(`/api/handset/callbacks/${lost.id}/resolve-uncertain`, { revision: lost.revision, note: 'Carrier console shows no call', outcome: 'not_placed' }, 200)
  await fresh()
  await t.tick(callbackClock + 7500000); assert.equal(t.placed.length, placedBefore + 1, 'only the owner decision makes it eligible again')
  // A definitive provider rejection is a failed attempt, not an uncertain one.
  const five = await open(5); await t.review(five.recipient, 480, 1020); await schedule(five, callbackClock + 7500000); t.create.reject = true
  await fresh(); await t.tick(callbackClock + 7500000)
  const rejected = (await t.state()).callbacks.find(c => c.recipient === five.recipient); assert.equal(rejected.state, 'waiting'); assert.equal(rejected.attempts, 1)
 } finally { await t.runtime.close() }
})
