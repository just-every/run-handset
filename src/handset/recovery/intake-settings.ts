import { escape as e, field, hidden, Fault, type ObjectValue } from '../core'
import { validateHours, type FlowHours } from '../flows/evaluation'

type Source = { id: string; e164: string }
type Policy = { source_id: string; timezone: string; hours: string; owner_name: string; revision: number; revoked_at: number | null; current: boolean }
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const confirmation = 'approve owned missed-call intake'

export function intakeHours(value: ObjectValue): FlowHours {
 const minute = (raw: unknown, end: boolean) => {
  if (end && raw === '24:00') return 1440
  if (typeof raw !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw new Fault(end ? 'invalid_intake_closes' : 'invalid_intake_opens')
  const [hour, minutes] = raw.split(':').map(Number)
  return hour * 60 + minutes
 }
 const days = weekdays.flatMap((_, index) => {
  const supplied = value[`day${index + 1}`]
  if (supplied === undefined) return []
  if (supplied !== String(index + 1)) throw new Fault('invalid_hours_days')
  return [index + 1]
 })
 return validateHours({ weekly: [{ days, startMinute: minute(value.opens, false), endMinute: minute(value.closes, true) }] })
}

export function intakeErrorMessage(error: Fault): string {
 if (error.code.includes('revision') || error.code === 'state_changed') return 'The intake settings changed. Review the current settings below, then approve again.'
 if (error.code === 'invalid_timezone') return 'Enter a recognized timezone, such as UTC, then review and approve again.'
 if (error.code === 'invalid_hours_days' || error.code === 'invalid_weekday') return 'Choose at least one weekday for task intake.'
 if (error.code === 'invalid_intake_opens' || error.code === 'invalid_intake_closes' || error.code === 'invalid_hours_window') return 'Enter local hours as HH:MM, with opening before closing. Closing may be 24:00.'
 if (error.code.includes('confirm') || error.code.includes('approval')) return 'Check the explicit approval after reviewing the source and local hours.'
 if (error.code.includes('source')) return 'This source is no longer available for these settings. Review the current sources below.'
 return 'The intake settings were not saved. Review the values below and try again.'
}

export function intakeSettings(snapshot: Record<string, unknown>): string {
 const sources = (snapshot.intakeSources ?? []) as Source[], policies = (snapshot.intakePolicies ?? []) as Policy[]
 const draft = snapshot.intakeDraft as ObjectValue | undefined, error = snapshot.intakeError
 return `<details${error ? ' open' : ''}><summary>Settings: missed-call intake</summary>${error ? `<p role="alert">${e(error)}</p>` : ''}<p>Task intake is off until an owner explicitly approves this source and its local hours. Approval creates owned tasks only; it never contacts customers. The approving owner receives new tasks. Existing recoveries and their decisions remain unchanged.</p>${sources.map(source => {
  const policy = policies.find(row => row.source_id === source.id)
  const hours = policy ? JSON.parse(policy.hours) as FlowHours : undefined, first = hours?.weekly[0]
  const editing = draft?.sourceId === source.id && 'opens' in draft ? draft : undefined
  const value = (name: string, initial: string) => editing && name in editing ? String(editing[name] ?? '') : initial
  const state = policy?.current ? 'On · reviewed task intake' : policy?.revoked_at ? 'Off · approval revoked' : policy ? 'Off · renewed approval required' : 'Off · no approval'
  const form = `<form method="post" action="/app/recovery/policies">${hidden('sourceId', source.id)}${hidden('revision', policy?.revision ?? 0)}${field('Timezone', 'timezone', value('timezone', policy?.timezone ?? 'UTC'))}${field('Opens (HH:MM, local)', 'opens', value('opens', clock(first?.startMinute ?? 540)))}${field('Closes (HH:MM, local; 24:00 allowed)', 'closes', value('closes', clock(first?.endMinute ?? 1020)))}<fieldset><legend>Weekdays for task intake</legend>${weekdays.map((day, index) => {
   const checked = editing ? editing[`day${index + 1}`] === String(index + 1) : (first?.days ?? [1, 2, 3, 4, 5]).includes(index + 1)
   return `<label><input type="checkbox" name="day${index + 1}" value="${index + 1}"${checked ? ' checked' : ''}> ${day}</label>`
  }).join('')}</fieldset><p>Approval replaces the reviewed hours with this one weekly window.</p><label><input type="checkbox" name="confirm" value="${confirmation}" required${editing?.confirm === confirmation ? ' checked' : ''}> I approve owned missed-call tasks for this source during these local hours, assigned to me.</label><button>Approve task intake</button></form>`
  return `<article data-intake-source="${e(source.id)}"><h3>${e(source.e164)}</h3><p>${e(state)}</p>${policy ? `<p>${policy.current ? 'Approving owner' : 'Last approving owner'}: ${e(policy.owner_name)} · ${e(policy.timezone)}</p><h4>Reviewed local hours</h4>${hours?.weekly.length ? `<ul>${hours.weekly.map(window => `<li>${e(window.days.map(day => weekdays[day - 1]).join(', '))}: ${clock(window.startMinute)}–${clock(window.endMinute)}</li>`).join('')}</ul>` : '<p>No weekly windows approved.</p>'}` : '<p>No reviewed local hours or approving owner yet.</p>'}${form}${policy?.current ? `<form method="post" action="/app/recovery/policies/revoke">${hidden('sourceId', source.id)}${hidden('revision', policy.revision)}<button>Revoke task intake</button></form>` : ''}</article>`
 }).join('') || '<p>No current inbound sources. Configure an inbound source before approving task intake.</p>'}</details>`
}
