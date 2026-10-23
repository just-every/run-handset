import { consolePage, escape as e, field } from '../core'
import { approval, area, bounds, details, due, form, nav, note, revision, type Row, type Snapshot, when } from '../automation/console'
export function followupsPage(snapshot: Snapshot) {
 const rows = snapshot.followups as Row[], counts = snapshot.counts as Record<string, number>
 return consolePage('Promised follow-ups', nav + '<p>Review the cited obligation and exact internal handoff. A delivery receipt does not complete a promise. Customer messages remain held.</p>' + bounds(`${counts.confirmed} confirmed · ${counts.due} due · ${counts.open} open · ${counts.declined} declined. ${snapshot.truncated ? 'The 200-record window is full; older records may be omitted.' : 'All follow-ups shown, up to 200 records.'}`) + '<section><h2>Extract a cited obligation</h2>' + form('/app/followups', 'Create cited draft', field('Case ID', 'caseId') + field('Source record ID', 'sourceId') + area('Exact obligation quote', 'obligation') + due() + field('Confirmation basis', 'confirmationBasis') + field('Orbit handoff target', 'target') + area('Exact handoff draft', 'draft')) + '</section><section><h2>Review promises</h2>' + (rows.length ? rows.map(r => {
  const base = '/app/followups/' + r.id, active = r.status === 'open', editable = ['draft','approved','held'].includes(String(r.delivery))
  return `<article id="followup-${e(r.id)}"><h3>${e(r.obligation)}</h3>${details([['Promise', r.status], ['Delivery', r.delivery], ['Cited source', r.source_id], ['Case', r.case_id], ['Owner', r.owner_id], ['Due at', when(r.due_at)], ['Confirmation basis', r.confirmation_basis], ['Target', r.target], ['Exact draft', r.draft], ['Reason', r.reason || 'Awaiting review']])}${r.readback ? `<details><summary>Receiving-system evidence</summary><pre>${e(r.readback)}</pre></details>` : ''}${active ?
   (['draft','held'].includes(String(r.delivery)) ? form(base + '/approve', 'Approve exact handoff', revision(r) + approval('approve exact cited handoff', 'I approve this cited internal disclosure')) : '') +
   (r.delivery === 'approved' ? form(base + '/deliver', 'Deliver approved handoff', revision(r)) : '') +
   (['sending','uncertain','received'].includes(String(r.delivery)) ? form(base + '/reconcile', 'Read current receiving state', revision(r)) : '') +
   (editable ? `<details><summary>Edit draft and due time</summary>${form(base + '/edit', 'Save edit for fresh approval', revision(r) + area('Revised draft', 'draft', String(r.draft)) + due(Number(r.due_at)))}</details>` : '') +
   form(base + '/cancel', 'Cancel follow-up', revision(r) + note()) + form(base + '/decline', 'Record explicit decline', revision(r) + note()) : ''}</article>`
 }).join('') : '<p>No promises yet.</p>') + '</section>')
}
