import type { Bindings } from '../auth.server'
import type { Session } from '../modules/operator-auth/index.mjs'
import { denied } from './audit/store'
import { escape as e, Fault, type ObjectValue } from './core'

/** A refused Settings save: its code, the form it came from and the person's own entries. */
export type Refusal = { code: string; status: number; action: string; values: ObjectValue; field?: string }

// Plain words for the refusals a person can correct in a Settings form.
const words: Record<string, string> = {
 invalid_timezone: 'That isn’t a timezone name. Use a region and city, such as America/Chicago.',
 invalid_businessName: 'Enter the business name.',
 invalid_callbackMinutes: 'Call back within 1 to 10,080 minutes (one week).',
 invalid_exceptionOwnerId: 'Exceptions go to an active owner. Enter that person’s ID.',
 named_person_must_be_active_owner: 'Exceptions go to an active owner. Enter that person’s ID.',
 invalid_orbitTarget: 'The Orbit handoff can be up to 200 characters.',
 invalid_maxDepositCents: 'Enter a largest deposit from 0 to 10,000 USD.',
 invalid_maxDiscountCents: 'Enter a largest discount from 0 to 10,000 USD.',
 invalid_maxRefundCents: 'Enter a largest refund from 0 to 10,000 USD.',
 service_deposit_exceeds_limit: 'This service’s deposit is more than the largest deposit. Lower it or raise the limit.',
 invalid_hours: 'A staffed day opens before it closes.',
 invalid_start: 'A staffed day needs both an opening and a closing time.',
 invalid_end: 'A staffed day needs both an opening and a closing time.',
 invalid_policy: 'Add at least one service.',
 invalid_serviceId: 'Each service needs an ID.',
 invalid_serviceName: 'Each service needs a name.',
 invalid_eventTypeId: 'Each service needs its booking event type ID.',
 invalid_bookingPage: 'Enter the booking page as handle/slug, such as mesa-ridge/install.',
 invalid_minutes: 'A service lasts 5 to 480 minutes.',
 invalid_depositCents: 'A service deposit is 0 to 10,000 USD.',
 duplicate_service: 'Two services share this ID. Give each service its own.',
 invalid_topic: 'Each answer needs a topic, the answer and its version.',
 invalid_value: 'Each answer needs a topic, the answer and its version.',
 invalid_version: 'Each answer needs a topic, the answer and its version.',
 invalid_caseId: 'Each mapping needs a case ID and a helpdesk conversation ID.',
 invalid_conversationId: 'Each mapping needs a case ID and a helpdesk conversation ID.',
 invalid_sourceId: 'Choose an approved inbound source. If none is listed, approve one first.',
 source_inactive: 'That inbound source is no longer approved. Choose another.',
 active_source_required: 'That inbound source is no longer approved. Choose another.',
 invalid_queueId: 'Choose a queue. If none is listed, create one in Queue setup first.',
 queue_missing: 'That queue no longer exists. Choose another.',
 invalid_staffTarget: 'Enter the staff number in full, such as +15055550100.',
 invalid_maxAttempts: 'The attempt limit is 1 to 3.',
 invalid_retrySeconds: 'Retry after 60 to 86,400 seconds.',
 invalid_name: 'Enter a queue name.',
 invalid_maxWaitSeconds: 'The maximum wait is 1 to 86,400 seconds.',
 invalid_wrapSeconds: 'Wrap-up is 0 to 3,600 seconds.',
 invalid_maxWaiting: 'Waiting and reserved capacity is 1 to 1,000 callers.',
 invalid_overflowQueueId: 'Choose the queue callers overflow to, or pick another overflow.',
 unexpected_overflow_queue: 'An overflow queue applies only to “Another queue”. Choose None, or choose Another queue.',
 overflow_cycle: 'That overflow sends callers back to this queue. Choose another.',
 agent_language_required: 'Add at least one language, such as en.',
 invalid_capacity: 'Capacity is 1 to 10 assignments at once.',
 invalid_spanish_digit: 'The Spanish menu digit is one digit, 0 to 9.',
 twilio_secret_binding_required: 'Signed queue routing needs this installation’s Twilio token first.',
 invalid_working_hours: 'The line opens before it closes. Use 24-hour times such as 08:00 and 18:00.',
 invalid_weekdays: 'Enter weekdays as numbers from 0 (Sunday) to 6 (Saturday), separated by commas.',
 invalid_weekday: 'Enter weekdays as numbers from 0 (Sunday) to 6 (Saturday), separated by commas.',
 invalid_forwarding_destination: 'Enter the forwarding number in full, such as +15055550100.',
 line_not_found: 'No line has that ID. Copy it from Current line IDs.',
 distinct_assistant_required: 'The assistant must be someone other than the executive.',
 active_people_required: 'Both the assistant and the executive must be active people.',
 delegation_not_found: 'No assistant grant has that ID.',
}
// Refusals whose field isn't the one named after "invalid_".
const fields: Record<string, string> = {
 invalid_maxDepositCents: 'maxDeposit', invalid_maxDiscountCents: 'maxDiscount', invalid_maxRefundCents: 'maxRefund', named_person_must_be_active_owner: 'exceptionOwnerId',
 source_inactive: 'sourceId', active_source_required: 'sourceId', queue_missing: 'queueId', overflow_cycle: 'overflowQueueId', unexpected_overflow_queue: 'overflowQueueId', agent_language_required: 'languages', invalid_spanish_digit: 'spanishDigit',
 invalid_working_hours: 'opens', invalid_weekday: 'weekdays', invalid_forwarding_destination: 'forwardTo', line_not_found: 'lineId', distinct_assistant_required: 'assistantId', delegation_not_found: 'delegationId',
}
const conflict = 'Someone saved a newer version while you were editing. Your draft is kept below. Compare the saved values, make any changes, then explicitly save the reviewed draft.'

/** Runs one owner's Settings save. An ordinary refusal stays a recorded 4xx, shown on the same Settings page with the person's entries. */
export async function settingsSave(env: Bindings, actor: Session, refused: Pick<Refusal, 'action' | 'values'>, save: () => Promise<Response | null>, again: (refusal: Refusal) => Promise<Response>) {
 try { return await save() } catch (error) {
  if (!(error instanceof Fault) || ![400, 404, 409].includes(error.status) || actor.operator.role !== 'owner') throw error
  await denied(env, actor, 'product.request')
  return again({ ...refused, code: error.code, status: error.status })
 }
}

const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
const controls = (form: string) => [...form.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)].map(([tag]) => tag)
const labelOf = (form: string, name: string) => form.match(new RegExp(`<label[^>]*>([^<]+)(?:</label>)?<(?:input|select|textarea)\\b[^>]*\\sname="${name.replaceAll('.', '\\.')}"`))?.[1]
const revisionField = (name: string) => /^(expectedVersion|version|revision|lineRevision)$/.test(name)
// Identity fields must still match. A stale revision identifies a conflict to compare.
function sameForm(form: string, values: ObjectValue, stale: boolean) {
 const tags = controls(form), names = new Set(tags.map(tag => attribute(tag, 'name')))
 return Object.keys(values).every(name => names.has(e(name))) && tags.every(tag => attribute(tag, 'type') !== 'hidden' || stale && revisionField(attribute(tag, 'name') ?? '') || e(values[attribute(tag, 'name') ?? ''] ?? '') === attribute(tag, 'value'))
}
/** Native submit buttons carry the reviewed revision only when explicitly chosen.
 * The ordinary save retains the submitted revision and cannot overwrite a newer save. */
function comparison(form: string, values: ObjectValue) {
 const revisions = controls(form).filter(tag => attribute(tag, 'type') === 'hidden' && revisionField(attribute(tag, 'name') ?? '') && attribute(tag, 'value') !== e(values[attribute(tag, 'name') ?? '']))
 const changed = controls(form).filter(tag => attribute(tag, 'type') !== 'hidden' && attribute(tag, 'value') !== undefined && values[attribute(tag, 'name') ?? ''] !== undefined && attribute(tag, 'value') !== e(values[attribute(tag, 'name') ?? '']))
 const rows = changed.map(tag => { const name = attribute(tag, 'name')!; return `<h3>${labelOf(form, name) ?? name}</h3><dl><dt>Your draft</dt><dd>${e(values[name]) || 'Empty'}</dd><dt>Current saved</dt><dd>${attribute(tag, 'value') || 'Empty'}</dd></dl>` }).join('')
 // More than one changed revision needs separate review; never guess a binding.
 const save = revisions.length === 1 ? `<button name="${attribute(revisions[0], 'name')}" value="${attribute(revisions[0], 'value')}">Save reviewed draft</button>` : ''
 return `<details class="hs-compare" id="settings-compare" open><summary>Compare saved values</summary>${rows}<p>Review the differences and edit your draft above. Saving the reviewed draft replaces the current saved values. A newer save will still be refused.</p>${save}</details>`
}
// Every disclosure around a position, open.
function openAround(html: string, at: number) {
 const around: number[] = []
 for (const m of html.slice(0, at).matchAll(/<details\b|<\/details>/g)) if (m[0] === '</details>') around.pop(); else around.push(m.index)
 return around.reverse().reduce((out, start) => out.slice(0, start) + out.slice(start).replace(/^<details\b([^>]*?)(?:\sopen)?>/, (_, attrs) => `<details${attrs} open>`), html)
}
/** The refused Settings form again: the person's entries back in place, the field the refusal names marked and explained, and anything folded around it open. Approval boxes are left for the person to tick again. */
export function withRefusal(body: string, refusal?: Refusal) {
 if (!refusal) return body
 const entered = (name: string) => typeof refusal.values[name] === 'string' ? String(refusal.values[name]) : undefined
 const stale = refusal.code.endsWith('_conflict')
 const named = refusal.field ?? fields[refusal.code] ?? (refusal.code.startsWith('invalid_') ? refusal.code.slice(8) : '')
 // With no field to focus, the explanation itself takes focus so it is in view.
 const note = (why: string, focus = true, compare = false) => `<div class="hs-problem" id="settings-problem" role="alert"${focus ? ' tabindex="-1" autofocus' : ''}><p>${e(why)}</p>${compare ? '<p><a href="#settings-compare">Compare saved values</a></p>' : ''}<details><summary>Technical detail</summary><code>${e(refusal.code)}</code></details></div>`
 let at = -1
 const filled = body.replace(/<form\b[^>]*>[\s\S]*?<\/form>/g, (form, index: number) => {
  if (at >= 0 || attribute(form, 'action') !== e(refusal.action) || !sameForm(form, refusal.values, stale)) return form
  at = index
  const field = controls(form).some(tag => attribute(tag, 'name') === e(named)) ? named : '', label = field ? labelOf(form, e(field)) : undefined
  const why = stale ? conflict : words[refusal.code] ?? (label ? `Check “${label}” and save again.` : 'This wasn’t saved. Check the entries below and save again.')
  const mark = (tag: string, name?: string) => field && name === e(field) ? tag.replace(/>$/, () => ' aria-invalid="true" aria-describedby="settings-problem" autofocus>') : tag
  const retained = form
   .replace(/<input\b[^>]*>/g, tag => {
    const name = attribute(tag, 'name'), value = name === undefined ? undefined : entered(name)
    if (attribute(tag, 'type') === 'hidden' && stale && revisionField(name ?? '') && value !== undefined) return tag.replace(/\svalue="[^"]*"/, () => ` value="${e(value)}"`)
    if (['hidden', 'checkbox', 'radio', 'submit'].includes(attribute(tag, 'type') ?? 'text')) return tag
    return mark(value === undefined ? tag : /\svalue="/.test(tag) ? tag.replace(/\svalue="[^"]*"/, () => ` value="${e(value)}"`) : tag.replace(/^<input\b/, () => `<input value="${e(value)}"`), name)
   })
   .replace(/<select\b[^>]*>[\s\S]*?<\/select>/g, select => {
    const name = attribute(select, 'name'), value = name === undefined ? undefined : entered(name)
    const chosen = value === undefined ? select : select.replace(/<option\b([^>]*)>([^<]*)<\/option>/g, (_, attrs: string, text: string) => {
     const plain = attrs.replace(/\s+selected(?=\s|$)/, '')
     return `<option${plain}${(attribute(plain, 'value') ?? text) === e(value) ? ' selected' : ''}>${text}</option>`
    })
    return chosen.replace(/^<select\b[^>]*>/, open => mark(open, name))
   })
   .replace(/<textarea\b([^>]*)>[\s\S]*?<\/textarea>/g, (area, attrs: string) => {
    const name = attribute(area, 'name'), value = name === undefined ? undefined : entered(name)
    return value === undefined ? area : `${mark(`<textarea${attrs}>`, name)}${e(value)}</textarea>`
   })
  // Append after hidden revision inputs: the clicked button's value wins in FormData.
  return retained.replace(/^<form\b[^>]*>/, open => open + note(why, !field, stale)).replace(/<\/form>$/, () => (stale ? comparison(form, refusal.values) : '') + '</form>')
 })
 if (at < 0) return note(stale ? 'This wasn’t saved because the form has changed. The current saved version is shown below.' : words[refusal.code] ?? 'This wasn’t saved. Check the entries below and save again.') + body
 const earlier = body.indexOf('<form') < at ? '<p class="hs-problem-link" role="status">This wasn’t saved. <a href="#settings-problem">Correct it below</a>.</p>' : ''
 return earlier + openAround(filled, at)
}
