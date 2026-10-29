import { consolePage, escape as e, field, hidden, type ObjectValue } from '../core'
import type { Compliance } from './doors'

export const caseKinds = { port_pin: 'Port PIN rejection', e911_move: 'Employee move', brand_registration: 'Brand registration', tollfree_verification: 'Toll-free verification', reputation: 'Reputation observation' }
export interface SourceChoice { id: string; number_id: string; account_id: string; revision: number; e164: string | null; status: string }
interface Person { id: string; display_name: string; role: string; status: string; version: number }
interface CaseEvent { id: string; kind: string; evidence: string; actor_id: string; actor_version: number; created_at: number }
export interface ComplianceView {
 cases: Compliance[]; case?: Compliance; events?: CaseEvent[]; sources: SourceChoice[]; people: Person[]
 actorId: string; actorVersion: number; creating: boolean; kind: Compliance['kind']
 draft?: { action: string; values: ObjectValue }; notice?: { message: string; status: number; held?: boolean }
}
const base = '/app/compliance'
const at = (value: number) => new Date(value).toISOString()
const local = (value: number) => at(value).slice(0, 16)
const facts = (pairs: [string, unknown][]) => `<dl>${pairs.map(([label, value]) => `<dt>${e(label)}</dt><dd>${e(value ?? 'Not available')}</dd>`).join('')}</dl>`
const select = (label: string, name: string, choices: [string, string][], value: unknown) => `<label for="compliance-${e(name)}">${e(label)}</label><select id="compliance-${e(name)}" name="${e(name)}" required>${choices.map(([key, title]) => `<option value="${e(key)}" ${key === value ? 'selected' : ''}>${e(title)}</option>`).join('')}</select>`
const area = (label: string, name: string, value: unknown) => `<label for="compliance-${e(name)}">${e(label)}</label><textarea id="compliance-${e(name)}" name="${e(name)}" rows="4" maxlength="2000" required>${e(value)}</textarea>`
const confirm = (value: string, label: string) => `<label><input type="checkbox" name="confirm" value="${e(value)}" required>${e(label)}</label>`
const person = (view: ComplianceView, id: string) => view.people.find(p => p.id === id)?.display_name ?? 'Retained person ' + id
const sourceFor = (view: ComplianceView, row: Compliance) => view.sources.find(s => s.id === row.source_id)
const values = (view: ComplianceView, action: string) => view.draft?.action === action ? view.draft.values : {}
const form = (row: Compliance, action: string, label: string, body = '') => `<form method="post" action="${base}/${e(row.id)}/${action}">${hidden('revision', row.revision)}${body}<button>${label}</button></form>`
const boundary = '<p role="status">Preparation only. Legal attestation and effect approval are separate. Voice and SMS readiness, clean compliance and clean reputation remain unproved.</p>'

function createForm(view: ComplianceView) {
 const v = values(view, ''), kind = view.kind, active = view.sources.filter(s => s.status === 'active')
 const input = (label: string, name: string, initial = '', type = 'text', required = true) => field(label, name, String(v[name] ?? initial), type, required)
 const fields = kind === 'port_pin' ? input('Port request ID', 'port_in_request_sid') + input('Port phone resource ID', 'phone_number_sid') + '<p>Wrong-PIN rejection category only. Exchange the correct PIN through the private carrier channel; never enter it here.</p>'
  : kind === 'e911_move' ? input('Endpoint record ID', 'endpointId') + input('Location record ID', 'locationRecordId') + input('Move notice record ID', 'changeNoticeRecordId')
  : kind === 'reputation' ? input('Receiving network', 'network') + input('Observed at (UTC)', 'observedAt', local(Date.now()), 'datetime-local') + input('Observed label', 'label') + input('Evidence record ID', 'evidenceRecordId')
  : input('Receipt ID', 'sid') + input('Reported status', 'status', kind === 'brand_registration' ? 'FAILED' : 'TWILIO_REJECTED') + input('Rejection reason', kind === 'brand_registration' ? 'failure_reason' : 'rejection_reason') + (kind === 'tollfree_verification' ? input('Rejection code', 'error_code', '', 'number', false) : '')
 return `<p><a href="${base}">All correction cases</a></p>${boundary}<form method="get" action="${base}/new">${select('Case type', 'kind', Object.entries(caseKinds), kind)}<button>Choose case type</button></form><section><h2>${e(caseKinds[kind])}</h2>${active.length ? `<form method="post" action="${base}/new">${hidden('kind', kind)}${select('Business number', 'sourceId', active.map(s => [s.id, `${s.e164 ?? s.number_id} · ${s.account_id} · Source revision ${s.revision}`]), v.sourceId ?? active[0].id)}${fields}${input('Due at (UTC)', 'dueAt', local(Date.now() + 3600000), 'datetime-local')}${confirm('prepare exact compliance case', 'I am preparing this exact source observation only')}<button>Prepare correction</button></form>` : '<p>No currently authorized business number is available. <a href="/app/sources">Review communication sources</a> before preparing a case.</p>'}</section>`
}

function listPage(view: ComplianceView) {
 return `${boundary}<section class="hs-list"><div class="hs-list-head"><h2>Unresolved correction cases</h2><span>${view.cases.length} retained</span></div>${view.cases.length ? `<ul class="hs-rows">${view.cases.map(row => {
  const source = sourceFor(view, row)
  return `<li><a class="hs-row" href="${base}/${e(row.id)}"><span><span class="hs-row-name">${e(caseKinds[row.kind])}</span><span class="hs-row-meta">${e(source?.e164 ?? row.number_id)} · ${e(person(view, row.owner_id))} · Due ${e(at(row.due_at))}</span></span><span class="hs-chip" data-tone="amber">${row.due_at <= Date.now() ? 'Overdue' : 'Follow-up due'}</span></a></li>`
 }).join('')}</ul>` : '<p class="hs-empty">No correction cases yet. Prepare a source observation to begin accountable follow-up.</p>'}<details class="hs-create" ${view.cases.length ? '' : 'open'}><summary>Prepare a correction</summary><ul>${Object.entries(caseKinds).map(([kind, label]) => `<li><a href="${base}/new?kind=${kind}">${e(label)}</a></li>`).join('')}</ul></details></section><p>All cases remain unresolved. Showing up to 200 cases, earliest due first.</p>`
}

const reportLabels: Record<string, string> = {
 port_in_request_sid: 'Port request', phone_number_sid: 'Port phone resource', port_in_phone_number_sid: 'Port phone resource', port_in_phone_number_status: 'Reported port state', rejection_reason: 'Reported rejection', sid: 'Receipt resource', account_sid: 'Reported account', status: 'Reported status', failure_reason: 'Reported failure', tollfree_phone_number: 'Reported number', error_code: 'Rejection category', endpointId: 'Endpoint record', locationRecordId: 'Location record', changeNoticeRecordId: 'Move notice record', network: 'Receiving network', observedAt: 'Observation time', label: 'Observed label', evidenceRecordId: 'Evidence record',
}
function reportFacts(row: Compliance) {
 const report = JSON.parse(row.report) as ObjectValue
 return facts(Object.entries(report).filter(([key]) => key in reportLabels).map(([key, value]) => [reportLabels[key], key === 'observedAt' ? at(Number(value)) : value]))
}

function history(view: ComplianceView) {
 return `<details ${view.draft?.action ? 'open' : ''}><summary>Review history</summary><ol>${(view.events ?? []).map(event => {
  const data = JSON.parse(event.evidence) as ObjectValue
  const title = { prepared: 'Observation prepared', reviewed: 'Preparation reviewed', follow_up: 'Continued follow-up assigned', readback: 'Provider receipt observed', held: 'Submission held' }[event.kind] ?? event.kind
  const pairs: [string, unknown][] = event.kind === 'reviewed' ? [['Prepared corrections', data.note], ['Effect approval', 'Not granted']]
   : event.kind === 'follow_up' ? [['Previous named owner', person(view, String(data.previousOwner))], ['Previous due time', at(Number(data.previousDueAt))], ['Named owner', person(view, String(data.ownerId))], ['Due at (UTC)', at(Number(data.dueAt))], ['Next action', data.nextAction]]
   : event.kind === 'readback' ? [['Provider state', data.state], ['Exact receipt', data.receiptId], ['Scope', data.scope], ['Readiness and reputation', 'Unproved']]
   : event.kind === 'held' ? [['Hold reason', data.reason]] : [['Provenance', data.trust]]
  return `<li><h3>${e(title)}</h3><p>${e(person(view, event.actor_id))} · Person version ${event.actor_version} · ${e(at(event.created_at))}</p>${facts(pairs)}</li>`
 }).join('') || '<li>No retained reviews.</li>'}</ol></details>`
}

function detailPage(view: ComplianceView) {
 const row = view.case!, source = sourceFor(view, row), named = view.people.find(p => p.id === row.owner_id)
 const currentOwner = named?.role === 'owner' && named.status === 'active' && named.version === row.owner_version
 const canReview = currentOwner && row.owner_id === view.actorId && row.owner_version === view.actorVersion
 const active = source?.status === 'active', review = values(view, 'review'), follow = values(view, 'follow-up')
 const lastFollow = [...(view.events ?? [])].reverse().find(event => event.kind === 'follow_up')
 const nextAction = lastFollow ? (JSON.parse(lastFollow.evidence) as ObjectValue).nextAction : row.plan
 const safe = row.readback ? JSON.parse(row.readback) as ObjectValue : undefined
 return `<p><a href="${base}">All correction cases</a></p>${boundary}<article><p class="hs-notice">${row.due_at <= Date.now() ? 'Overdue' : 'Follow-up due'} · Unresolved</p>${facts([
  ['Business number', source?.e164 ?? row.number_id], ['Named owner', person(view, row.owner_id) + (currentOwner ? '' : ' · Current owner assignment required')], ['Due at (UTC)', at(row.due_at)], ['Next action', nextAction], ['Preparation state', row.status.replaceAll('_', ' ')], ['Provider state', row.provider_state],
 ])}<h2>Actionable corrections</h2><p>${e(row.plan)}</p>${row.approval_note ? `<h3>Prepared corrections</h3><p>${e(row.approval_note)}</p>` : '<p>No preparation review has been recorded.</p>'}<details><summary>Exact source and reported observation</summary>${facts([
  ['Case ID', row.id], ['Case revision', row.revision], ['Source ID', row.source_id], ['Source revision', source?.revision], ['Source authority', source?.status ?? 'Unavailable'], ['Selected account', source?.account_id], ['Selected number record', row.number_id], ['Receipt reference', row.reference], ['Created at', at(row.created_at)],
 ])}<p>Owner-supplied observation. Independent provider qualification remains required.</p>${reportFacts(row)}</details><h2>Provider uncertainty</h2>${safe ? facts([
  ['Last observed at', at(Number(safe.observedAt))], ['Observed state', safe.state], ['Exact receipt', safe.receiptId], ['Scope', safe.scope], ['Reported port date', safe.portDate ?? 'Not supplied'], ['Rejection category', safe.rejectionCode ?? 'Not supplied'], ['Voice readiness', safe.voiceReady], ['SMS readiness', safe.smsReady], ['Reputation', safe.reputation],
 ]) : '<p>No independent provider receipt has been observed. Carrier, employee and per-network confirmation remain pending.</p>'}${!active ? '<p role="alert">This source is no longer authorized. Existing history is retained; no new provider read or effect is permitted. <a href="/app/sources">Review sources</a>.</p>' : ''}</article><section><h2>Preparation and continued follow-up</h2><details ${view.draft?.action === 'review' ? 'open' : ''}><summary>Review prepared corrections</summary><p>This records preparation review only. The named person must separately attest legal facts, sign the LOA or confirm a dispatchable location; exact effect approval remains required.</p>${canReview && active ? form(row, 'review', 'Record preparation review', area('Prepared corrections', 'note', review.note ?? row.approval_note) + confirm('review exact correction preparation', 'I reviewed this preparation; legal attestation and effect approval remain separate')) : '<p>Assign this case to a current active owner before that person reviews its preparation.</p>'}</details><details ${view.draft?.action === 'follow-up' ? 'open' : ''}><summary>Continue named follow-up</summary>${active ? form(row, 'follow-up', 'Assign continued follow-up', select('Named owner', 'ownerId', view.people.filter(p => p.role === 'owner' && p.status === 'active').map(p => [p.id, p.display_name]), follow.ownerId ?? row.owner_id) + field('Due at (UTC)', 'dueAt', String(follow.dueAt ?? local(Math.max(row.due_at, Date.now() + 3600000))), 'datetime-local') + area('Next action', 'nextAction', follow.nextAction ?? nextAction) + confirm('assign exact continued follow-up', 'Keep this case due to the selected active owner')) : '<p>Restore current source authority before assigning further work.</p>'}</details><details ${['readback', 'submit'].includes(view.draft?.action ?? '') || view.notice?.held ? 'open' : ''}><summary>Provider receipt and submission hold</summary><p>Receipt readback performs an identity-checked provider read. It does not confirm readiness or reputation. Submission remains held: no number move, active emergency-address change, replacement purchase, rotation, spend or third-party Free Caller Registry filing is authorized.</p>${active ? form(row, 'readback', 'Read exact provider receipt', confirm('read exact compliance receipt', 'Read the exact selected account and receipt')) + (canReview ? form(row, 'submit', 'Check submission hold') : '<p>Only the current named owner can check submission.</p>') : ''}</details></section><section><h2>Retained review history</h2>${history(view)}</section>`
}

export function compliancePage(view: ComplianceView) {
 return consolePage(view.creating ? 'Prepare correction case' : view.case ? caseKinds[view.case.kind] : 'Number compliance', `${view.notice ? `<p role="${view.notice.held ? 'status' : 'alert'}">${view.notice.held ? 'Submission or readback held. ' : ''}${e(view.notice.message)}</p>` : ''}${view.creating ? createForm(view) : view.case ? detailPage(view) : listPage(view)}`, view.notice?.status ?? 200)
}
export function complianceDenied() {
 return consolePage('Compliance access needed', '<p role="alert">Only a current owner can prepare or inspect number compliance cases. Ask an owner to review this work.</p><p><a href="/app">Return to workspace</a></p>', 403)
}
