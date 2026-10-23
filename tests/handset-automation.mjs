import assert from 'node:assert/strict'
import { test } from 'node:test'
import { post } from './helpers/handset-auth.mjs'
import { receptionistFixture, mailTo, mailText } from './helpers/handset-receptionist.mjs'
import { sourceFixture } from './helpers/handset-sources.mjs'

const definition = (trigger, action = 'internal', delayMinutes = 0) => ({ name: 'Austin callback / Devolver llamada', trigger, action, message: 'Review this customer promise / Revise esta promesa', delayMinutes, timezone: 'America/Chicago', startMinute: 0, endMinute: 1440 })
async function setup() {
 const f = await receptionistFixture(), source = await sourceFixture(f.runtime)
 const missed = async n => {
  const response = await source.callback({ From: `+1512555${String(2000 + n)}`, CallSid: `synthetic-handset-rule-${n}`, CallStatus: 'no-answer', SequenceNumber: '0', Timestamp: new Date().toISOString() })
  assert.equal(response.status, 200); return response.json()
 }
 const native = async (kind, n) => (await f.create('/api/handset/records', { kind, sourceId: `synthetic-handset-rule-native-${n}`, caseId: f.cases[0], occurredAt: Date.now(), data: kind === 'callback' ? { state: 'pending', dueAt: Date.now() - 1000 } : { text: 'Customer requested written quote' } })).record
 const publish = async (d, sampleId, extra = {}) => {
  const p = await f.create('/api/handset/rules/preview', { definition: d, sampleRecordId: sampleId, ...extra })
  assert.equal(p.matched, true); assert.equal(p.effectOccurred, false)
  return f.create('/api/handset/rules/publish', { previewId: p.previewId, confirm: 'publish exact tested rule' })
 }
 const ingest = async (recordId, trigger) => { const response = await post(f.runtime, '/api/handset/rules/events', { recordId, trigger }, f.headers); assert.equal(response.status, 202, await response.clone().text()) }
 const snapshot = async () => (await f.runtime.request('/api/handset/rules', { headers: f.headers })).json()
 return { ...f, source, missed, native, publish, ingest, snapshot }
}

test('Previewed missed-call, disposition and callback-due rules retain one owned next step through replay and restart', async () => {
 const f = await setup()
 try {
  const missed = await f.missed(1), disposition = await f.native('disposition', 1), callback = await f.native('callback', 2)
  const samples = [['missed_call', missed.recordId], ['disposition', disposition.id], ['callback_due', callback.id]]
  for (const [trigger, record] of samples) {
   await f.publish(definition(trigger), record)
   await f.ingest(record, trigger); await f.ingest(record, trigger)
  }
  await f.runtime.scheduled()
  let state = await f.snapshot()
  assert.equal(state.runs.length, 3)
  assert.ok(state.runs.every(r => r.state === 'owned' && r.work_status === 'open' && r.owner_id === 'synthetic-handset-1' && Number.isSafeInteger(r.next_due_at)))
  await f.runtime.restart(); await f.runtime.scheduled()
  state = await f.snapshot(); assert.equal(state.runs.length, 3)
  // Competing rules with the same semantic action cannot contact twice.
  await f.publish({ ...definition('disposition'), name: 'Another rule on the same disposition' }, disposition.id)
  await f.ingest(disposition.id, 'disposition'); await f.runtime.scheduled()
  assert.equal((await f.snapshot()).runs.length, 3)
  assert.equal((await f.runtime.request('/api/handset/rules')).status, 401)
  assert.equal((await post(f.runtime, '/api/handset/rules/publish', {}, { authorization: 'Bearer ' + f.issued.token })).status, 401)
 } finally { await f.runtime.close() }
})

test('Exact rule edits, pause and signed STOP cancel pending work before an owner notice can be sent', async () => {
 const f = await setup()
 try {
  const sample = await f.missed(10), d = definition('missed_call', 'owner_email', 5)
  const rule = await f.publish(d, sample.recordId)
  await f.ingest(sample.recordId, 'missed_call'); await f.runtime.scheduled()
  assert.equal((await f.snapshot()).runs[0].state, 'queued')
  await f.publish({ ...d, message: 'Corrected exact owner notice' }, sample.recordId, { ruleId: rule.ruleId, expectedRevision: rule.revision })
  await f.runtime.scheduled(Date.now() + 6 * 60000)
  assert.match((await f.snapshot()).runs[0].reason, /version/)
  const other = await f.missed(11)
  await f.ingest(other.recordId, 'missed_call'); await f.runtime.scheduled()
  const current = (await f.snapshot()).rules.find(r => r.id === rule.ruleId)
  assert.equal((await post(f.runtime, '/api/handset/rules/pause', { ruleId: rule.ruleId, revision: current.revision }, f.headers)).status, 200)
  assert.ok((await f.snapshot()).runs.every(r => r.state === 'canceled'))
  const stopCall = await f.missed(12)
  await f.publish(d, stopCall.recordId); await f.ingest(stopCall.recordId, 'missed_call'); await f.runtime.scheduled()
  assert.equal((await f.source.callback({ From: '+15125552012', MessageSid: 'synthetic-handset-rule-stop', MessageStatus: 'received', Body: 'STOP', Timestamp: new Date().toISOString() })).status, 200)
  await f.runtime.scheduled(Date.now() + 6 * 60000)
  const stopped = (await f.snapshot()).runs.find(r => r.record_id === stopCall.recordId)
  assert.equal(stopped.state, 'canceled'); assert.match(stopped.reason, /STOP/)
  assert.equal(mailTo(f.runtime, f.runtime.ownerEmail).filter(m => /Handset follow-up/.test(m.subject)).length, 0)
 } finally { await f.runtime.close() }
})

test('An explicitly published owner notice is accepted once and never completes its promise or replays after an uncertain send', async () => {
 const f = await setup()
 try {
  const disposition = await f.native('disposition', 21)
  await f.publish(definition('disposition', 'owner_email'), disposition.id)
  await f.ingest(disposition.id, 'disposition'); await f.runtime.scheduled()
  let state = await f.snapshot(), run = state.runs[0]
  assert.equal(run.state, 'accepted'); assert.equal(run.work_status, 'open')
  const messages = () => mailTo(f.runtime, f.runtime.ownerEmail).filter(m => /Handset follow-up/.test(m.subject))
  assert.equal(messages().length, 1); assert.match(mailText(messages()[0]), /A sent reminder does not complete this work/)
  assert.ok(mailText(messages()[0]).includes(disposition.id) && mailText(messages()[0]).includes(run.id))
  await f.runtime.restart(); await f.runtime.scheduled(); assert.equal(messages().length, 1)
  const uncertain = await f.native('disposition', 22)
  f.runtime.setMailFailure()
  await f.ingest(uncertain.id, 'disposition'); await f.runtime.scheduled()
  run = (await f.snapshot()).runs.find(r => r.record_id === uncertain.id)
  assert.ok(['uncertain','failed'].includes(run.state)); assert.equal(run.work_status, 'open')
  const attempts = messages().length
  f.runtime.setMailFailure(false); await f.runtime.restart(); await f.runtime.scheduled(); assert.equal(messages().length, attempts, 'no blind retry after ambiguous send')
  const held = await f.native('disposition', 23)
  await f.publish(definition('disposition', 'zapier'), held.id)
  await f.ingest(held.id, 'disposition'); await f.runtime.scheduled()
  state = await f.snapshot(); assert.ok(state.runs.some(r => r.action === 'zapier' && r.state === 'held' && /unqualified/.test(r.reason)))
 } finally { await f.runtime.close() }
})
