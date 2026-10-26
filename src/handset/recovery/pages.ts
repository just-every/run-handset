import { consolePage, escape as e, field } from '../core'
import { bounds, details, due, form, note, revision, type Row, type Snapshot, when } from '../automation/console'
import { intakeSettings } from './intake-settings'
export function recoveryPage(snapshot: Snapshot) {
 const rows = snapshot.cases as Row[]
 const open = '<details class="hs-create hs-create-page"><summary>Open a recovery</summary><p class="hs-hint">Keep each customer need owned. Callback proposals do not dial; text and calling remain held until qualified authority exists. A delivered message never resolves a need.</p>' + form('/app/recovery', 'Open owned recovery', field('Verified missed-call record ID', 'callRecordId') + due() + field('Maximum attempts (1 to 3)', 'maxAttempts', '1', 'number') + field('Queue entry ID (optional)', 'queueEntryId', '', 'text', false)) + '</details>'
 return consolePage('Missed-call recovery', bounds(`${snapshot.overdue} overdue${snapshot.truncated ? '. The 200-case window is full; older cases may be omitted.' : ''}`) + intakeSettings(snapshot) + '<section><h2>Customer needs</h2>' + (rows.length ? rows.map(r => {
  const base = '/app/recovery/' + r.id, active = ['open','human','escalated'].includes(String(r.state))
  return `<article id="recovery-${e(r.id)}"><h3>${e(r.state)} · ${e(r.recipient)}</h3>${details([['Case', r.case_id], ['Missed-call source', r.call_record_id], ['Owner', r.owner_id], ['Due at', when(r.due_at)], ['Attempt limit', r.max_attempts], ['Reason', r.reason]])}<details><summary>Preserved queue place</summary><pre>${e(r.queue_place)}</pre></details>${r.resolution ? `<details><summary>Verified resolution evidence</summary><pre>${e(r.resolution)}</pre></details>` : ''}${active ?
   (r.state !== 'human' ? form(base + '/takeover', 'Take over recovery', revision(r) + note()) : '<p>Human takeover blocks callback proposals.</p>') +
   form(base + '/stop', 'Stop recovery', revision(r) + note()) + form(base + '/decline', 'Record customer decline', revision(r) + note()) +
   `<details><summary>Reassign to an active owner</summary>${form(base + '/assign', 'Assign owner', revision(r) + field('New owner ID', 'ownerId') + note())}</details>` +
   (r.state === 'open' ? `<details><summary>Propose callback time</summary>${form(base + '/callback-proposal', 'Save callback proposal', revision(r) + field('Timezone', 'timezone', 'America\u002fChicago') + due(Number(r.due_at)))}</details>` : '') +
   `<details><summary>Resolve from a confirmed booking</summary>${form(base + '/resolve', 'Verify same-case booking', revision(r) + field('Confirmed outcome ID', 'outcomeId'))}</details>` +
   (Number(r.due_at) <= Date.now() ? form(base + '/escalate', 'Escalate overdue recovery', revision(r) + note()) : '') : ''}</article>`
 }).join('') : '<p>No recovery cases yet.</p>') + '</section>' + open)
}
