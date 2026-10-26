import { consolePage, escape as e, field } from '../core'
import { approval, details, due, form, note, revision, type Row, type Snapshot, when } from '../automation/console'
import { withRefusal, type Refusal } from '../refusal'

const options = (rows: Row[], label: (r: Row) => string) => rows.map(r => `<option value="${e(r.id)}">${e(label(r))}</option>`).join('')
export function callbacksPage(snapshot: Snapshot) {
 const { inForce } = policyParts(snapshot)
 const callbacks = snapshot.callbacks as Row[], attempts = snapshot.attempts as Row[], recoveries = snapshot.recoveries as Row[]
 const policy = `<section class="hnd-panel"><h2>Caller-requested callbacks</h2>${inForce}<p><a href="/app/callbacks/settings">Change the callback policy</a></p></section>`
 const rows = callbacks.map(c => `<article id="callback-${e(c.id)}"><h3>${e(String(c.state))} · ${e(c.recipient)} · ${e(String(c.kind).replace('_', ' '))}</h3>${details([['Place in line', Number(c.ahead) + 1], ['Queued at', when(c.queued_at)], ['Due at', when(c.due_at)], ['Attempts', c.attempts], ['Reason', c.reason]])}${attempts.filter(a => a.callback_id === c.id).map(a => `<p>Attempt ${a.attempt_no}: ${e(a.state)} · ${e(a.reason)}</p>`).join('')}` +
  (['waiting', 'uncertain'].includes(String(c.state)) ? form(`/app/callbacks/${c.id}/cancel`, 'Cancel callback', revision(c) + note()) : '') +
  (c.state === 'uncertain' ? form(`/app/callbacks/${c.id}/resolve-uncertain`, 'Resolve uncertain attempt', revision(c) + note() + `<label for="outcome-${e(c.id)}">Outcome</label><select id="outcome-${e(c.id)}" name="outcome"><option value="not_placed">The call was not placed</option><option value="placed">The call was placed</option></select>`) : '') + '</article>').join('')
 const schedule = `<section class="hnd-panel"><h2>Schedule a callback</h2>${form('/app/callbacks', 'Schedule callback', `<label for="schedule-recoveryId">Open recovery</label><select id="schedule-recoveryId" name="recoveryId">${options(recoveries, r => String(r.recipient))}</select>${due()}${field('Evidence the customer asked', 'evidence')}${approval('the customer asked for this callback', 'The customer asked for this callback')}`)}</section>`
 const how = '<details class="hs-tertiary"><summary>How callbacks work</summary><p>A callback dials only inside the owner-reviewed local hours for that number, in retained order, one attempt at a time.</p><p>A busy or unanswered attempt stays an open owned task. A callback completes only after a verified conversation, a customer decline or a documented human decision.</p></details>'
 return consolePage('Callbacks', how + `<section class="hnd-panel"><h2>Callbacks in retained order</h2>${rows || '<p>No callbacks yet.</p>'}</section>` + schedule + policy)
}

function policyParts(snapshot: Snapshot) {
 const policies = snapshot.policies as Row[], sources = snapshot.sources as Row[], queues = snapshot.queues as Row[]
 return { inForce: `${policies.map(p => details([['Source', p.source_id], ['Queue', p.queue_id], ['Rings staff at', p.staff_target], ['Attempt limit', p.max_attempts], ['Retry after seconds', p.retry_seconds], ['Enabled', p.enabled ? 'yes' : 'no']])).join('') || '<p>No callback policy is approved. Callers hear no virtual hold offer.</p>'}
`, form: `${form('/app/callbacks/policies', 'Save callback policy', `<label for="policy-sourceId">Business number</label><select id="policy-sourceId" name="sourceId">${options(sources, r => String(r.e164))}</select><label for="policy-queueId">Queue</label><select id="policy-queueId" name="queueId">${options(queues, r => String(r.name))}</select>${field('Staff number to ring', 'staffTarget')}${field('Business name spoken to callers', 'businessName')}${field('Attempt limit', 'maxAttempts', '2', 'number')}${field('Retry after seconds', 'retrySeconds', '900', 'number')}${approval('approve caller-requested callbacks', 'I approve calling back only callers who asked, inside reviewed recipient hours')}`)}` }
}
/** The callback policy, under Settings. */
export function callbackSettingsPage(snapshot: Snapshot, refusal?: Refusal) {
 const { inForce, form } = policyParts(snapshot)
 return consolePage('Callback policy', withRefusal(`<p class="hs-sub">Who may be called back from <a href="/app/callbacks">Callbacks</a>.</p><section><h2>In force</h2>${inForce}</section><section><h2>Approve or change the callback policy</h2>${form}</section>`, refusal), refusal?.status)
}
