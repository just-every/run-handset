import assert from 'node:assert/strict'
import { post } from './handset-auth.mjs'
import { sourceFixture } from './handset-sources.mjs'

export async function workJourney({ f, page, proof, domain }) {
 const { runtime } = f, root = '/app/' + domain
 const read = async () => (await runtime.request('/api/handset/' + domain, { headers: f.headers })).json()
 const click = async (scope, name) => { await scope.getByRole('button', { name, exact: true }).click(); await page.waitForLoadState('load') }
 const fill = async (scope, entries) => { for (const [label, value] of Object.entries(entries)) await scope.getByLabel(label, { exact: true }).fill(String(value)) }
 const utc = at => new Date(at).toISOString().slice(0, 16)
 await page.goto(runtime.origin + root); await proof(domain + '-empty')
 if (domain === 'rules') {
  const source = await sourceFixture(runtime)
  const missed = await source.callback({ From: '+15125552301', CallSid: 'synthetic-handset-console-rule', CallStatus: 'no-answer', SequenceNumber: '0', Timestamp: new Date().toISOString() })
  assert.equal(missed.status, 200)
  const samples = [['missed_call', (await missed.json()).recordId]]
  for (const kind of ['disposition', 'callback']) {
   const made = await f.create('/api/handset/records', { kind, sourceId: 'synthetic-handset-console-' + kind, caseId: f.cases[0], occurredAt: Date.now(), data: kind === 'callback' ? { state: 'pending', dueAt: Date.now() - 1000 } : { text: 'Send written estimate' } })
   samples.push([kind === 'callback' ? 'callback_due' : kind, made.record.id])
  }
  for (const [trigger, recordId] of samples) {
   await page.goto(runtime.origin + root)
   const editor = page.locator('form').first()
   await fill(editor, { 'Rule name': 'Austin ' + trigger, 'Exact message': 'Review <customer> promise safely', 'Matching source record ID': recordId, 'Allowed start minute (local, 0 to 1439)': 0, 'Allowed end minute (local, 1 to 1440)': 1440 })
   await editor.getByLabel('Trigger', { exact: true }).selectOption(trigger)
   await editor.getByLabel('Rule name', { exact: true }).focus()
   assert.equal(await editor.getByLabel('Rule name', { exact: true }).evaluate(el => el === document.activeElement), true)
   await click(editor, 'Preview rule')
   assert.match(await page.locator('main').innerText(), /Review <customer> promise safely/)
   assert.equal((await read()).rules.length, samples.findIndex(s => s[0] === trigger), 'preview alone publishes nothing')
   await proof('rules-preview-' + trigger)
   await page.getByRole('checkbox').check(); await click(page, 'Publish exact tested rule')
   assert.equal((await post(runtime, '/api/handset/rules/events', { recordId, trigger }, f.headers)).status, 202)
  }
  await runtime.scheduled(); await runtime.restart(); await page.goto(runtime.origin + root)
  const state = await read(); assert.equal(state.rules.length, 3); assert.equal(state.runs.length, 3)
  assert.ok(state.runs.every(r => r.state === 'owned' && r.work_status === 'open'))
  await proof('rules-owned-after-restart')
  const rule = state.rules[0], staleRevision = rule.revision
  const revise = page.locator('#rule-' + rule.id).locator('details'); await revise.locator('summary').click()
  await fill(revise, { 'Matching source record ID': samples.find(s => s[0] === JSON.parse(rule.definition).trigger)[1], 'Exact message': 'Human revised promise notice' })
  await click(revise, 'Preview rule')
  const preview = page.locator('input[name="previewId"]'); const previewId = await preview.inputValue()
  await page.getByRole('checkbox').check(); await click(page, 'Publish exact tested rule')
  assert.equal((await read()).rules.find(r => r.id === rule.id).revision, staleRevision + 1)
  const stale = await page.request.post(runtime.origin + root + '/publish', { headers: { origin: runtime.origin }, form: { previewId, confirm: 'publish exact tested rule' } })
  assert.equal(stale.status(), 403, 'used previews cannot publish again')
  await page.locator('#rule-' + rule.id).getByRole('button', { name: 'Pause rule', exact: true }).click(); await page.waitForLoadState('load')
  assert.equal((await read()).rules.find(r => r.id === rule.id).state, 'paused'); await proof('rules-paused')
 }
 if (domain === 'followups') {
  const ids = []
  for (let n = 0; n < 3; n++) {
   const quote = n === 1 ? 'Enviar el presupuesto por escrito' : 'Send written estimate ' + n
   const source = (await f.create('/api/handset/records', { kind: 'promise', sourceId: 'synthetic-handset-console-promise-' + n, occurredAt: Date.now(), caseId: f.cases[n], data: { text: quote, dueAt: Date.now() - 60000 } })).record
   await page.goto(runtime.origin + root)
   await fill(page.locator('form').first(), { 'Case ID': f.cases[n], 'Source record ID': source.id, 'Exact obligation quote': quote, 'Due at (UTC)': utc(Date.now() - 60000), 'Confirmation basis': 'Current owning handoff completed', 'Orbit handoff target': `opportunities/synthetic-handset-720/handoffs/synthetic-handset-${970 + n}`, 'Exact handoff draft': quote })
   await click(page, 'Create cited draft')
   let row = (await read()).followups.find(r => r.source_id === source.id); ids.push(row.id)
   let card = page.locator('#followup-' + row.id)
   await card.getByRole('checkbox').check(); await click(card, 'Approve exact handoff')
   if (n === 2) f.edges.drop.add('orbit')
   await click(page.locator('#followup-' + row.id), 'Deliver approved handoff')
   row = (await read()).followups.find(r => r.id === row.id)
   assert.equal(row.status, 'open'); assert.equal(row.delivery, n === 2 ? 'uncertain' : 'received')
   assert.ok(f.edges.effects.get(row.operation_key).handoff.content.includes(source.id), 'independent receiver retains the citation')
   if (n < 2) f.edges.handoffStates.set(row.target, 'completed')
   await click(page.locator('#followup-' + row.id), 'Read current receiving state')
  }
  const posts = f.edges.requests.filter(r => r.method === 'POST').length
  await runtime.restart(); await page.goto(runtime.origin + root)
  assert.match(await page.locator('[role="status"]').innerText(), /2 confirmed · 1 due · 1 open/)
  assert.equal(f.edges.effects.size, 3); assert.equal(f.edges.requests.filter(r => r.method === 'POST').length, posts)
  await proof('followups-two-confirmed-one-due')
  const row = (await read()).followups.find(r => r.id === ids[2]), card = page.locator('#followup-' + row.id)
  await card.getByLabel('Evidence note', { exact: true }).first().fill('Customer withdrew the promise')
  await click(card, 'Cancel follow-up'); await proof('followups-canceled')
  assert.equal((await read()).followups.find(r => r.id === row.id).status, 'canceled')
 }
 if (domain === 'recovery') {
  const source = await sourceFixture(runtime)
  const calls = []
  for (let n = 0; n < 3; n++) {
   if (n === 2) await f.create('/api/handset/protection/stops', { numberId: source.numberId, recipient: '+15125552402', channel: 'all', reason: 'dnc', confirm: 'record outbound consent stop' })
   const response = await source.callback({ From: '+1512555240' + n, CallSid: 'synthetic-handset-console-missed-' + n, CallStatus: 'no-answer', SequenceNumber: '0', Timestamp: new Date().toISOString() })
   assert.equal(response.status, 200); calls.push(await response.json())
   await page.goto(runtime.origin + root)
   await fill(page.locator('form').first(), { 'Verified missed-call record ID': calls[n].recordId, 'Due at (UTC)': utc(Date.now() + 3600000), 'Maximum attempts (1 to 3)': 2 })
   await click(page, 'Open owned recovery')
  }
  await page.getByText('Settings: missed-call intake', { exact: true }).click()
  let intake = page.locator('[data-intake-source="' + source.source.id + '"]')
  await fill(intake, { 'Timezone': 'Not_A_Timezone', 'Opens (HH:MM, local)': '00:00', 'Closes (HH:MM, local; 24:00 allowed)': '24:00' })
  for (const day of ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']) await intake.getByLabel(day, { exact: true }).check()
  await intake.getByRole('checkbox').last().check()
  await click(intake, 'Approve task intake')
  await page.getByRole('alert').filter({ hasText: 'recognized timezone' }).waitFor()
  intake = page.locator('[data-intake-source="' + source.source.id + '"]')
  assert.equal(await intake.getByLabel('Timezone', { exact: true }).inputValue(), 'Not_A_Timezone')
  assert.equal(await intake.getByLabel('Opens (HH:MM, local)', { exact: true }).inputValue(), '00:00')
  await proof('recovery-intake-refused-preserves-values')
  await intake.getByLabel('Timezone', { exact: true }).fill('UTC')
  await click(intake, 'Approve task intake')
  await page.getByText('Settings: missed-call intake', { exact: true }).click()
  assert.ok((await read()).intakePolicies[0].current)
  await proof('recovery-intake-approved')
  const { intakeCall } = await import('./handset-recovery-intake.mjs')
  const automatic = intakeCall(runtime, source, 90), observed = await automatic.send()
  assert.equal(observed.status, 200, await observed.clone().text())
  await page.reload()
  assert.equal((await read()).cases.length, 4)
  await proof('recovery-automatic-task')
  await page.getByText('Settings: missed-call intake', { exact: true }).click()
  await click(page.locator('[data-intake-source="' + source.source.id + '"]'), 'Revoke task intake')
  const held = intakeCall(runtime, source, 91); assert.equal((await held.send()).status, 200)
  assert.equal((await read()).cases.length, 4)
  await page.getByText('Settings: missed-call intake', { exact: true }).click()
  assert.ok(!(await read()).intakePolicies[0].current)
  await proof('recovery-intake-revoked')
  const rows = (await read()).cases, first = rows.find(r => r.call_record_id === calls[0].recordId), second = rows.find(r => r.call_record_id === calls[1].recordId)
  assert.equal(rows.find(r => r.call_record_id === calls[2].recordId).state, 'stopped')
  const card = page.locator('#recovery-' + first.id)
  await card.locator('form').filter({ has: page.getByRole('button', { name: 'Take over recovery', exact: true }) }).getByLabel('Evidence note', { exact: true }).fill('Mara is handling this caller')
  await click(card, 'Take over recovery')
  assert.equal(await page.locator('#recovery-' + first.id).getByRole('button', { name: 'Save callback proposal' }).count(), 0)
  await proof('recovery-human-takeover-and-suppressed')
  const stale = await page.request.post(runtime.origin + root + '/' + first.id + '/stop', { headers: { origin: runtime.origin }, form: { revision: String(first.revision), note: 'Stale browser tab' } })
  assert.equal(stale.status(), 409)
  const decline = page.locator('#recovery-' + second.id).locator('form').filter({ has: page.getByRole('button', { name: 'Record customer decline', exact: true }) })
  await decline.getByLabel('Evidence note', { exact: true }).fill('Customer declined further contact'); await click(decline, 'Record customer decline')
  await runtime.restart(); await runtime.scheduled(Date.now() + 7200000); await page.goto(runtime.origin + root)
  assert.equal((await read()).cases.find(r => r.id === first.id).state, 'escalated')
  assert.equal((await read()).cases.find(r => r.id === second.id).state, 'declined')
  assert.equal(runtime.sourceRequests.filter(r => r.method === 'POST').length, 0)
  await proof('recovery-overdue-after-restart')
 }
 if (domain === 'operations') {
  await f.savePolicy(); const source = await sourceFixture(runtime)
  const call = await source.callback({ From: '+15125552500', CallSid: 'synthetic-handset-console-media', CallStatus: 'no-answer', SequenceNumber: '0', Timestamp: new Date().toISOString() })
  const missed = await call.json()
  await f.create('/api/handset/recovery', { callRecordId: missed.recordId, dueAt: Date.now() - 1000, maxAttempts: 1 })
  runtime.twilioResources.set('https://insights.twilio.com/v1/Voice/synthetic-handset-console-media/Summary', { account_sid: source.account, call_sid: 'synthetic-handset-console-media', processing_state: 'complete', tags: ['high_jitter','high_packet_loss'] })
  f.edges.orbitExpired = true
  await page.getByLabel('Verified call record ID', { exact: true }).fill(missed.recordId); await click(page, 'Assess continuity risks')
  const row = (await read()).assessments[0]
  assert.match(await page.locator('main').innerText(), /high_jitter, high_packet_loss/)
  assert.match(await page.locator('main').innerText(), /scope_or_oauth_refused/)
  assert.match(await page.locator('main').innerText(), /not_run/)
  await proof('operations-cited-media-and-connector-risk')
  const card = page.locator('#assessment-' + row.id)
  await card.getByLabel('Evidence note', { exact: true }).fill('Review route test and CRM repair; keep callbacks owned')
  await card.getByRole('checkbox').check(); await click(card, 'Record exact review decision')
  await runtime.restart(); await page.goto(runtime.origin + root)
  assert.equal((await read()).assessments[0].state, 'approved'); await proof('operations-review-applies-no-fix')
  const exported = await page.request.get(runtime.origin + root + '/' + row.id + '/export'); assert.equal(exported.status(), 200)
  const evidence = await exported.json(); assert.equal(evidence.pendingCallbackCount, 1); assert.match(evidence.receiver, /pending/)
  assert.ok(!JSON.stringify(evidence).includes('+1512555'))
  assert.equal(runtime.sourceRequests.filter(r => r.method !== 'GET').length, 0)
 }
}
