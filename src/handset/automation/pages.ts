import { consolePage, escape as e, field, hidden } from '../core'
import { area, bounds, details, form, type Row, type Snapshot, when } from './console'
import type { RuleDefinition } from './rules'
const options = (name: string, label: string, values: string[], selected: string) => `<label>${e(label)}<select name="${name}" aria-label="${e(label)}">${values.map(v => `<option value="${v}"${v === selected ? ' selected' : ''}>${e(v.replaceAll('_', ' '))}</option>`).join('')}</select></label>`
function editor(row?: Row) {
 const d: RuleDefinition = row ? JSON.parse(String(row.definition)) : { name: '', trigger: 'missed_call', action: 'internal', message: '', delayMinutes: 0, timezone: 'America\u002fChicago', startMinute: 480, endMinute: 1200 }
 return form('/app/rules/preview', 'Preview rule', (row ? hidden('ruleId', row.id) + hidden('expectedRevision', row.revision) : '') + field('Rule name', 'name', d.name) + options('trigger', 'Trigger', ['missed_call','disposition','callback_due'], d.trigger) + options('action', 'Action', ['internal','owner_email','crank','zapier','sms'], d.action) + area('Exact message', 'message', d.message) + field('Matching source record ID', 'sampleRecordId') + field('Delay (minutes)', 'delayMinutes', String(d.delayMinutes), 'number') + field('Timezone', 'timezone', d.timezone) + field('Allowed start minute (local, 0 to 1439)', 'startMinute', String(d.startMinute), 'number') + field('Allowed end minute (local, 1 to 1440)', 'endMinute', String(d.endMinute), 'number'))
}
export function rulesPage(snapshot: Snapshot) {
 const rules = snapshot.rules as Row[], runs = snapshot.runs as Row[]
 return consolePage('Follow-up rules', '<p>Test each rule against a matching source, review its exact effect, then publish. Sending a reminder leaves the promised work open.</p>' + bounds('Showing at most 100 rules and 200 recent runs. Customer contact and unqualified workflow receivers remain held.') + '<section><h2>Preview a new rule</h2>' + editor() + '</section><section><h2>Published rules</h2>' + (rules.length ? rules.map(r => {
  const d = JSON.parse(String(r.definition)) as RuleDefinition
  return `<article id="rule-${e(r.id)}"><h3>${e(d.name)} · ${e(r.state)}</h3>${details([['Revision', r.revision], ['Trigger', d.trigger], ['Action', d.action], ['Owner', r.owner_id], ['Exact message', d.message]])}${r.state === 'active' ? form('/app/rules/pause', 'Pause rule', hidden('ruleId', r.id) + hidden('revision', r.revision)) : ''}<details><summary>Revise ${e(d.name)}</summary>${editor(r)}</details></article>`
 }).join('') : '<p>No published rules yet.</p>') + '</section><section><h2>Run history</h2>' + (runs.length ? runs.map(r => `<article id="run-${e(r.id)}"><h3>${e(r.state)} · work ${e(r.work_status)}</h3>${details([['Source', r.record_id], ['Rule', r.rule_id], ['Owner', r.owner_id], ['Next due', when(r.next_due_at)], ['Reason', r.reason || 'Owned next step']])}</article>`).join('') : '<p>No runs yet.</p>') + '</section>')
}
