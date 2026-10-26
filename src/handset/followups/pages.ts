import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { consolePage, escape as e, field } from '../core'
import { clock, eventLine } from '../records/events'
import { area, details, revision, type Row, type Snapshot, when } from '../automation/console'
import { caseDetails, caller, citable, recent, type CaseDetail } from './caller'

/** A refused create: the code, and the person's own entries to put back in the form. */
export type Refusal = { code: string; status: number; values: Record<string, unknown> }

const views = [['open', 'Needs follow-up'], ['handed', 'Handed off'], ['done', 'Done']] as const
type View = typeof views[number][0]
const viewOf = (r: Row): View => r.status !== 'open' ? 'done' : r.delivery === 'received' ? 'handed' : 'open'
const chip = (label: string, tone = '') => `<span class="hs-chip"${tone ? ` data-tone="${tone}"` : ''}>${e(label)}</span>`
const span = (ms: number) => { const minutes = Math.max(1, Math.round(Math.abs(ms) / 60000)); return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h` }
const settled: Record<string, [string, string]> = { confirmed: ['Confirmed', ''], canceled: ['Canceled', ''], declined: ['Declined', 'red'], escalated: ['Escalated', 'red'] }
const soon = (r: Row, now: number) => Number(r.due_at) - now <= 900000

// One chip per row: the settled state, else what this follow-up needs next.
function rowChip(r: Row, now: number) {
 if (r.status !== 'open') { const [label, tone] = settled[String(r.status)] ?? [String(r.status), '']; return chip(label, tone) }
 if (r.delivery === 'approved') return chip('Approved', 'blue')
 if (r.delivery === 'received') return chip('Handed off', 'blue')
 if (r.delivery === 'held') return chip('Held', 'amber')
 if (r.delivery === 'sending' || r.delivery === 'uncertain') return chip('Check Orbit', 'amber')
 return chip('Due ' + clock(r.due_at), soon(r, now) ? 'amber' : '')
}

// What the person does next, in their words.
const next: Record<string, string> = { draft: 'Needs your approval', held: 'Orbit held it; approve again', approved: 'Approved; send it to Orbit', sending: 'Sent; check Orbit before anything else', uncertain: 'Check what Orbit received', received: 'With Orbit until it is completed' }

function actions(r: Row) {
 const base = '/app/followups/' + r.id, delivery = String(r.delivery), form = `act-${e(r.id)}`
 const [path, label] = ['draft', 'held'].includes(delivery) ? ['approve', 'Approve handoff'] : delivery === 'approved' ? ['deliver', 'Send handoff to Orbit'] : ['reconcile', 'Check Orbit status']
 const consent = path === 'approve' ? '<label><input type="checkbox" name="confirm" value="approve exact cited handoff" required> I approve this exact handoff to Orbit. Customer messages stay held, and Orbit’s receipt doesn’t complete the promise.</label>' : ''
 const edit = ['draft', 'approved', 'held'].includes(delivery) ? `<details class="hs-secondary"><summary>Edit draft</summary><form method="post" action="${base}/edit">${revision(r)}${area('Revised draft', 'draft', String(r.draft))}${field('Due at (UTC)', 'dueAt', new Date(Number(r.due_at)).toISOString().slice(0, 16), 'datetime-local')}<p class="hs-hint">An edited draft needs a fresh approval.</p><button>Save edit</button></form></details>` : ''
 const close = `<details class="hs-tertiary"><summary>Cancel or decline</summary><form method="post" action="${base}/cancel">${revision(r)}${field('Note for the record', 'note')}<div class="hs-buttons"><button>Cancel follow-up</button><button formaction="${base}/decline">Record decline</button></div></form></details>`
 return `<form class="hs-consent" id="${form}" method="post" action="${base}/${path}">${revision(r)}${consent}</form><div class="hs-actions"><button class="hs-primary" form="${form}">${label}</button>${edit}${close}</div>`
}

function detail(r: Row, c: CaseDetail | undefined, now: number) {
 const who = caller(c, String(r.case_id)), left = Number(r.due_at) - now, open = r.status === 'open'
 const contact = [who.number && `<span class="hs-mono">${e(who.number)}</span>`, who.line && `${e(who.line)} line`, c && `<a href="/app/cases/${e(r.case_id)}">${e(who.title)}</a>`].filter(Boolean).join('<span aria-hidden="true">·</span>')
 const events = recent(c)
 const timeline = events.length ? `<ol class="hs-timeline" aria-label="Recent events">${events.map(x => `<li><time class="hs-mono" datetime="${e(when(x.at))}">${e(clock(x.at))}</time><span>${e(x.text)}</span></li>`).join('')}</ol>` : '<p class="hs-hint">No events on this case yet.</p>'
 const notice = open
  ? `<p class="hs-notice"${soon(r, now) ? '' : ' data-tone="grey"'}><span>Due ${e(clock(r.due_at))}</span><span>${left >= 0 ? span(left) + ' left' : span(left) + ' overdue'}</span><span>${e(r.reason || next[String(r.delivery)] || 'Awaiting review')}</span></p>`
  : `<p class="hs-notice" data-tone="grey"><span>${e(settled[String(r.status)]?.[0] ?? r.status)}</span>${r.reason ? `<span>${e(r.reason)}</span>` : ''}</p>`
 const evidence = r.readback ? `<details><summary>What Orbit reported</summary><pre>${e(r.readback)}</pre></details>` : ''
 return `<article id="followup-${e(r.id)}" aria-labelledby="followup-name"><h2 id="followup-name">${e(who.name)}</h2>${contact ? `<p class="hs-contact">${contact}</p>` : ''}${timeline}<hr class="hs-cord">`
  + `<div class="hs-note"><img src="/brand/mark.svg" alt="" width="22" height="22"><p>${e(r.draft)}</p></div>${notice}${open ? actions(r) : ''}`
  + `<details class="hs-facts"><summary>Details</summary>${details([['Promise quoted', r.obligation], ['Promise', r.status], ['Handoff', r.delivery], ['Due at', when(r.due_at)], ['Completed when', r.confirmation_basis], ['Orbit handoff', r.target], ['Cited source', r.source_id], ['Case', r.case_id], ['Owner', r.owner_id]])}${evidence}</details></article>`
}

// Each refusal names the field to correct and says why in plain words; the code stays as technical detail.
const refusals: Record<string, [string, string]> = {
 cited_source_required: ['sourceId', 'That source isn’t a promise, transcript or call note on this case. Choose one of the case’s own records.'],
 source_superseded: ['sourceId', 'That source was corrected by a newer record. Cite the newer record instead.'],
 promise_replay_conflict: ['sourceId', 'This source already has a follow-up with different details. Cite another record or open the existing follow-up.'],
 obligation_not_in_cited_source: ['obligation', 'The quote must appear word for word in the cited source.'],
 selected_orbit_handoff_required: ['target', 'Enter the Orbit handoff as opportunities/<id>/handoffs/<id>.'],
 case_not_found: ['caseId', 'No case has that ID. Copy it from the case page.'],
 invalid_dueAt: ['dueAt', 'Enter the due date and time.'],
}

function createForm(refusal: Refusal | undefined, c: CaseDetail | undefined) {
 const v = refusal?.values ?? {}, [bad, why] = refusal ? refusals[refusal.code] ?? ['', 'The follow-up wasn’t created. Check the entries below.'] : ['', '']
 const value = (name: string) => typeof v[name] === 'string' ? String(v[name]) : ''
 const problem = (name: string) => name === bad ? ` aria-invalid="true" aria-describedby="create-problem" autofocus` : ''
 const input = (label: string, name: string, type = 'text', hint = '') => `<label>${e(label)}${hint ? `<span class="hs-hint">${e(hint)}</span>` : ''}<input name="${name}" type="${type}" value="${e(value(name))}" required${problem(name)}></label>`
 const text = (label: string, name: string) => `<label>${e(label)}<textarea name="${name}" rows="3" required${problem(name)}>${e(value(name))}</textarea></label>`
 const sources = citable(c)
 const source = bad === 'sourceId' && sources.length
  ? `<label>Cited source<select name="sourceId"${problem('sourceId')}>${sources.map(s => `<option value="${e(s.id)}">${e(clock(s.occurred_at))} · ${e(eventLine(s).slice(0, 90))}</option>`).join('')}</select></label>`
  : input('Cited source record', 'sourceId', 'text', 'A promise, transcript or call note on this case.') + (bad === 'sourceId' && c ? `<p class="hs-hint">This case has no promise, transcript or call note yet. <a href="/app/cases/${e(c.current.id)}/record?kind=promise">Add the promise to the case</a> first.</p>` : '')
 const alert = refusal ? `<div class="hs-problem" id="create-problem" role="alert"><p>${e(why)}</p><details><summary>Technical detail</summary><code>${e(refusal.code)}</code></details></div>` : ''
 return `<details class="hs-create" id="new-followup"${refusal ? ' open' : ''}><summary>New follow-up</summary>${alert}<form method="post" action="/app/followups">`
  + input('Case ID', 'caseId') + source + text('Promise, quoted exactly', 'obligation')
  + `<label>Due at (UTC)<input name="dueAt" type="datetime-local" value="${e(value('dueAt') || new Date(Date.now() + 3600000).toISOString().slice(0, 16))}" required${problem('dueAt')}></label>`
  + input('Completed when', 'confirmationBasis') + input('Orbit handoff', 'target', 'text', 'opportunities/<id>/handoffs/<id>') + text('Handoff draft', 'draft')
  + '<button class="hs-primary">Create follow-up</button></form></details>'
}

const today = (now: number) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(now).replace(',', '') + ` · ${clock(now)} UTC`

export async function followupsPage(snapshot: Snapshot, url: URL, request: Request, env: Bindings, actor: Session, refusal?: Refusal) {
 const rows = snapshot.followups as Row[], now = Date.now()
 const view = (views.find(([key]) => key === url.searchParams.get('view'))?.[0] ?? 'open') as View
 const shown = rows.filter(r => viewOf(r) === view), chosen = shown.find(r => r.id === url.searchParams.get('followup')) ?? shown[0]
 const cases = await caseDetails(request, env, actor, [...shown.map(r => String(r.case_id)), ...(typeof refusal?.values.caseId === 'string' ? [refusal.values.caseId] : [])])
 const tabs = `<nav class="hs-filters" aria-label="Follow-up filters">${views.map(([key, label]) => `<a href="/app/followups?view=${key}"${key === view ? ' aria-current="page"' : ''}>${label}<span class="hs-count">${rows.filter(r => viewOf(r) === key).length}</span></a>`).join('')}</nav>`
 const list = shown.length ? `<ol class="hs-rows">${shown.map(r => {
  const c = cases.get(String(r.case_id)), who = caller(c, String(r.case_id)), cited = c?.records.find(x => x.id === r.source_id)
  const at = cited?.occurred_at ?? Number(r.created_at)
  return `<li><a class="hs-row" href="/app/followups?view=${view}&amp;followup=${e(r.id)}#detail"${r === chosen ? ' aria-current="true"' : ''}><span><span class="hs-row-name">${e(who.name)}</span><span class="hs-row-meta">${[who.line, who.reason].filter(Boolean).map(e).join(' · ')}</span></span><time class="hs-mono" datetime="${e(when(at))}">${e(clock(at))}</time>${rowChip(r, now)}</a></li>`
 }).join('')}</ol>` : `<p class="hs-empty">${view === 'open' ? 'Nothing needs a follow-up.' : view === 'handed' ? 'Nothing is with Orbit.' : 'Nothing is done yet.'}</p>`
 const truncated = snapshot.truncated ? '<p class="hs-hint">Showing the first 200 follow-ups by due time.</p>' : ''
 const pane = chosen ? detail(chosen, cases.get(String(chosen.case_id)), now) : `<article><p class="hs-empty">Choose a follow-up to see its caller, recent events and next step.</p></article>`
 const createCase = typeof refusal?.values.caseId === 'string' ? cases.get(refusal.values.caseId) : undefined
 return consolePage('Follow-ups', `<p class="hs-sub">${e(today(now))}</p>${refusal ? `<p class="hs-problem-link" role="status">The follow-up wasn’t created. <a href="#new-followup">Correct it below</a>.</p>` : ''}<div class="hs-split"><section class="hs-list" aria-label="Follow-ups">${tabs}${list}${truncated}${createForm(refusal, createCase)}</section><div class="hs-pane" id="detail">${pane}</div></div>`, refusal?.status ?? 200)
}
