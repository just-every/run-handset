import { consolePage, escape as e, field } from '../core'
import { approval, area, bounds, details, due, form, nav, note, revision, type Row, type Snapshot, when } from '../automation/console'

const clock = (at: unknown) => new Date(Number(at)).toISOString().slice(11, 16)
const day = (at: unknown) => new Date(Number(at)).toISOString().slice(0, 10)
const span = (ms: number) => { const minutes = Math.max(1, Math.round(Math.abs(ms) / 60000)); return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h` }
const chip = (label: string, tone = '') => `<span class="hs-chip"${tone ? ` data-tone="${tone}"` : ''}>${e(label)}</span>`
const closed: Record<string, string> = { confirmed: '', canceled: '', declined: 'red', escalated: 'red' }
// One chip per row: the promise's state once settled, else what needs attention next.
function rowChip(r: Row, now: number) {
 if (r.status !== 'open') return chip(String(r.status).replace(/^./, c => c.toUpperCase()), closed[String(r.status)] ?? '')
 if (r.delivery === 'uncertain' || r.delivery === 'held') return chip(r.delivery === 'held' ? 'Held' : 'Uncertain', 'amber')
 return chip('Due ' + clock(r.due_at), Number(r.due_at) - now <= 900000 ? 'amber' : '')
}

function card(r: Row, now: number) {
 const base = '/app/followups/' + r.id, active = r.status === 'open', editable = ['draft','approved','held'].includes(String(r.delivery)), left = Number(r.due_at) - now
 const evidence = r.readback ? `<details><summary>Receiving-system evidence</summary><pre>${e(r.readback)}</pre></details>` : ''
 const forward = active ? (['draft','held'].includes(String(r.delivery)) ? form(base + '/approve', 'Approve exact handoff', revision(r) + approval('approve exact cited handoff', 'I approve this cited internal disclosure')) : '') +
  (r.delivery === 'approved' ? form(base + '/deliver', 'Deliver approved handoff', revision(r)) : '') +
  (['sending','uncertain','received'].includes(String(r.delivery)) ? form(base + '/reconcile', 'Read current receiving state', revision(r)) : '') : ''
 const edit = active && editable ? `<details><summary>Edit draft and due time</summary>${form(base + '/edit', 'Save edit for fresh approval', revision(r) + area('Revised draft', 'draft', String(r.draft)) + due(Number(r.due_at)))}</details>` : ''
 return `<article id="followup-${e(r.id)}"><h3>${e(r.obligation)}</h3><p class="hs-meta"><span class="hs-mono">${e(day(r.due_at))} ${e(clock(r.due_at))} UTC</span>${chip('Promise ' + r.status)}${chip('Delivery ' + r.delivery)}</p>`
  + details([['Cited source', r.source_id], ['Case', r.case_id], ['Owner', r.owner_id], ['Due at', when(r.due_at)], ['Confirmation basis', r.confirmation_basis], ['Target', r.target]])
  + `<hr class="hs-cord"><div class="hs-note"><img src="/brand/mark.svg" alt="" width="22" height="22"><div><p>${e(r.draft)}</p>${evidence}</div></div>`
  + (active ? `<p class="hs-notice"${left > 900000 ? ' data-tone="grey"' : ''}>Due ${e(clock(r.due_at))} UTC · ${left >= 0 ? span(left) + ' left' : span(left) + ' overdue'} · ${e(r.reason || 'Awaiting review')}</p>` : `<p class="hs-notice" data-tone="grey">${e(r.reason || 'Awaiting review')}</p>`)
  + (active ? `<div class="hs-actions">${forward}${edit}</div><div class="hs-close">${form(base + '/cancel', 'Cancel follow-up', revision(r) + note())}${form(base + '/decline', 'Record explicit decline', revision(r) + note())}</div>` : '')
  + '</article>'
}

export function followupsPage(snapshot: Snapshot, url?: URL) {
 const rows = snapshot.followups as Row[], counts = snapshot.counts as Record<string, number>, now = Date.now()
 const chosen = rows.find(r => r.id === url?.searchParams.get('followup')) ?? rows[0]
 const create = '<section><h2>Extract a cited obligation</h2>' + form('/app/followups', 'Create cited draft', field('Case ID', 'caseId') + field('Source record ID', 'sourceId') + area('Exact obligation quote', 'obligation') + due() + field('Confirmation basis', 'confirmationBasis') + field('Orbit handoff target', 'target') + area('Exact handoff draft', 'draft')) + '</section>'
 const list = `<section class="hs-list" aria-labelledby="followup-list"><div class="hs-list-head"><h2 id="followup-list">Review promises<span class="hs-count">${rows.length}</span></h2></div>` + (rows.length
  ? `<ol class="hs-rows">${rows.map(r => `<li><a class="hs-row" href="/app/followups?followup=${e(r.id)}"${r === chosen ? ' aria-current="true"' : ''}><span><span class="hs-row-name">${e(r.obligation)}</span><span class="hs-row-meta">${e(r.status)} · ${e(r.delivery)}</span></span><time class="hs-mono" datetime="${e(when(r.created_at))}">${e(clock(r.created_at))}</time>${rowChip(r, now)}</a></li>`).join('')}</ol>`
  : '<p class="hs-empty">No promises yet.</p>') + '</section>'
 const head = bounds(`${counts.confirmed} confirmed · ${counts.due} due · ${counts.open} open · ${counts.declined} declined. ${snapshot.truncated ? 'The 200-record window is full; older records may be omitted.' : 'All follow-ups shown, up to 200 records.'}`) + nav + '<p>Review the cited obligation and exact internal handoff. A delivery receipt does not complete a promise. Customer messages remain held.</p>'
 if (!chosen) return consolePage('Promised follow-ups', head + list + create)
 return consolePage('Promised follow-ups', head + `<div class="hs-split"><div>${list}${create}</div><div class="hs-pane">${[chosen, ...rows.filter(r => r !== chosen)].map(r => card(r, now)).join('')}</div></div>`)
}
