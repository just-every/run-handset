import { consolePage, escape as e, field, hidden } from '../core'
import type { Contact, ContactCapabilities } from './doors'

export type DirectoryContact = Omit<Contact, 'sources'> & { sources: string[]; capabilities: ContactCapabilities }
export interface DirectoryView {
 contacts: DirectoryContact[]
 contact?: DirectoryContact
 other?: DirectoryContact
 creating: boolean
 editing: boolean
 merging: boolean
 isOwner: boolean
 draft?: Record<string, unknown>
 notice?: { message: string; status: number }
 completed?: boolean
}

const base = '/app/directory'
const path = (contact: DirectoryContact) => `${base}/${encodeURIComponent(contact.id)}`
const phone = (contact: DirectoryContact) => contact.number + (contact.extension ? ` ext ${contact.extension}` : '')
const timezone = (contact: DirectoryContact) => contact.timezone || 'Timezone unknown'
const boundary = '<p role="status">Preparation only. Contact context does not authenticate callers or grant message consent or employee access.</p>'
const back = `<p><a href="${base}">All contacts</a></p>`
const facts = (pairs: [string, unknown][]) => `<dl>${pairs.map(([label, value]) => `<dt>${e(label)}</dt><dd>${e(value)}</dd>`).join('')}</dl>`
const checked = (value: unknown) => value === 1 || value === '1'
const checkbox = (name: string, label: string, value = '1', selected = false, required = false) => `<label><input type="checkbox" name="${e(name)}" value="${e(value)}"${selected ? ' checked' : ''}${required ? ' required' : ''}>${e(label)}</label>`
const sources = (contact: DirectoryContact) => contact.sources.length ? `<ul>${contact.sources.map(source => `<li class="hs-mono">${e(source)}</li>`).join('')}</ul>` : '<p>No source IDs recorded.</p>'
const canMerge = (contact: DirectoryContact) => contact.visibility === 'company' && contact.capabilities.merge

function contactFacts(contact: DirectoryContact) {
 return facts([
  ['Name', contact.name], ['Phone number', phone(contact)], ['Timezone', timezone(contact)],
  ['Visibility', contact.visibility === 'personal' ? 'Personal · unshared' : 'Company · current authority required'],
  ['Suppression', contact.suppressed ? 'Suppressed' : 'No suppression recorded'],
  ['Hold', contact.held ? 'Held' : 'No hold recorded'], ['Revision', contact.revision],
 ])
}

function contactFields(view: DirectoryView, contact?: DirectoryContact) {
 const draft = view.draft ?? {}
 const value = (name: string, initial: string) => String(draft[name] ?? initial)
 return field('Name', 'name', value('name', contact?.name ?? ''))
  + field('Phone number with calling code and optional extension', 'number', value('number', contact ? phone(contact) : ''), 'tel')
  + field('Timezone (leave empty if unknown)', 'timezone', value('timezone', contact?.timezone ?? ''), 'text', false)
}

function createPage(view: DirectoryView) {
 const draft = view.draft ?? {}, visibility = draft.visibility ?? 'personal'
 const sourceText = Array.isArray(draft.sources) ? draft.sources.join('\n') : String(draft.sources ?? '')
 return `${back}${boundary}<section><h2>New contact</h2><form method="post" action="${base}/new">${contactFields(view)}<label>Visibility<select name="visibility"><option value="personal"${visibility === 'personal' ? ' selected' : ''}>Personal · unshared</option>${view.isOwner ? `<option value="company"${visibility === 'company' ? ' selected' : ''}>Company</option>` : ''}</select></label><label>Source IDs (one per line)<textarea name="sources" rows="4">${e(sourceText)}</textarea></label>${checkbox('suppressed', 'Keep this contact suppressed', '1', checked(draft.suppressed))}${checkbox('held', 'Keep this contact on hold', '1', checked(draft.held))}<button>Create contact</button></form><p>Personal contacts stay private to their native owner. Company contacts require current authority and explicit member read grants.</p></section>`
}

function listPage(view: DirectoryView) {
 return `${boundary}<section class="hs-list" aria-label="Directory contacts"><div class="hs-list-head"><h2>Contacts</h2><span>${view.contacts.length} visible</span></div>${view.contacts.length ? `<ul class="hs-rows">${view.contacts.map(contact => `<li><a class="hs-row" href="${path(contact)}"><span><span class="hs-row-name">${e(contact.name)}</span><span class="hs-row-meta">${e(phone(contact))} · ${e(timezone(contact))} · ${contact.visibility === 'personal' ? 'Personal · unshared' : 'Company'}</span></span>${contact.suppressed || contact.held ? `<span class="hs-chip" data-tone="amber">${contact.suppressed ? 'Suppressed' : 'Held'}${contact.suppressed && contact.held ? ' +1' : ''}</span>` : ''}</a></li>`).join('')}</ul>` : '<p class="hs-empty">No contacts are currently visible. Create a personal contact to begin.</p>'}<details class="hs-create"${view.contacts.length ? '' : ' open'}><summary>Create contact</summary><p><a href="${base}/new">New contact</a></p></details></section>`
}

function authority(contact: DirectoryContact) {
 return `<details><summary>Privacy and current authority</summary><p>${contact.visibility === 'personal' ? 'This personal contact is private to its native owner and cannot be shared or merged.' : 'Company contact reads and actions require current native authority. Member read, edit, export and merge permissions are separate. Editing or merging withdraws member grants; reading does not authorize another action.'}</p><p>These native records do not synchronize a tenant directory or authorize changes to authoritative domain profiles.</p></details>`
}

function detailPage(view: DirectoryView) {
 const contact = view.contact!
 const actions = contact.capabilities.edit || canMerge(contact)
 return `${back}${boundary}<article>${contactFacts(contact)}<details><summary>Source identities</summary>${sources(contact)}</details>${authority(contact)}</article>${actions ? `<details><summary>Edit or merge contact</summary>${contact.capabilities.edit ? `<p><a href="${path(contact)}/edit">Edit contact</a></p>` : ''}${canMerge(contact) ? `<p><a href="${path(contact)}/merge">Review an explicit merge</a></p>` : ''}</details>` : ''}`
}

function editPage(view: DirectoryView) {
 const contact = view.contact!
 if (!contact.capabilities.edit) return `${back}${boundary}<p role="alert">Current edit permission is required.</p>`
 const stale = view.notice?.status === 409
 const revision = view.draft?.revision ?? contact.revision
 return `${back}${boundary}<p><a href="${path(contact)}">Return to contact</a></p><section><h2>Edit contact</h2>${stale ? `<p role="alert">The contact changed after your edit began. Your submitted changes are retained below. Compare them with the current record before applying them.</p><h3>Current record</h3>${contactFacts(contact)}<p><a href="${path(contact)}/edit">Start again from the current record</a></p><h3>Your submitted changes</h3>` : ''}<p>Editing withdraws this record's member grants. Suppression, holds and source IDs remain retained.</p><form method="post" action="${path(contact)}/edit">${hidden('revision', revision)}${contactFields(view, contact)}${stale ? hidden('freshRevision', contact.revision) + checkbox('reconcile', 'I compared my changes with the current record and approve applying these reviewed changes.', 'apply reviewed changes', false, true) : ''}<button>${stale ? 'Apply reviewed changes' : 'Save contact changes'}</button></form></section>`
}

function mergeChoices(view: DirectoryView) {
 const contact = view.contact!, choices = view.contacts.filter(other => other.id !== contact.id && canMerge(other))
 return `<details open><summary>Choose a contact to merge</summary><p>This contact will be the keeper. Its name, phone number, extension and timezone remain.</p>${choices.length ? `<form method="get" action="${path(contact)}/merge"><label>Other company contact<select name="otherId" required><option value="">Choose a contact</option>${choices.map(other => `<option value="${e(other.id)}">${e(other.name)} · ${e(phone(other))} · ${e(timezone(other))}</option>`).join('')}</select></label><button>Review selected contacts</button></form>` : '<p>No other company contact is currently eligible for merging.</p>'}</details>`
}

function mergePage(view: DirectoryView) {
 const contact = view.contact!, other = view.other
 if (!canMerge(contact)) return `${back}${boundary}<p role="alert">Current merge permission for a company contact is required.</p>`
 const prefix = `${back}${boundary}<p><a href="${path(contact)}">Return to keeper contact</a></p>`
 if (!other) return prefix + mergeChoices(view)
 if (other.id === contact.id || !canMerge(other)) return `${prefix}<p role="alert">Both records must be distinct company contacts with current merge permission.</p>${mergeChoices(view)}`
 const stale = view.notice?.status === 409
 const comparison = `<div class="hs-field-grid"><section><h2>Keeper contact</h2>${contactFacts(contact)}<h3>Source IDs</h3>${sources(contact)}</section><section><h2>Contact to combine</h2>${contactFacts(other)}<h3>Source IDs</h3>${sources(other)}</section></div>`
 const reviewLink = `${path(contact)}/merge?${new URLSearchParams({ otherId: other.id })}`
 const switched = `${path(other)}/merge?${new URLSearchParams({ otherId: contact.id })}`
 const resultSources = [...new Set([...contact.sources, ...other.sources])].sort()
 const result = `<section><h2>After merging</h2>${facts([['Keeper name', contact.name], ['Keeper phone number', phone(contact)], ['Keeper timezone', timezone(contact)], ['Suppression', contact.suppressed || other.suppressed ? 'Suppressed' : 'No suppression recorded'], ['Hold', contact.held || other.held ? 'Held' : 'No hold recorded']])}<h3>Combined source IDs</h3>${sources({ ...contact, sources: resultSources })}<p>Both records' member grants will be withdrawn before the combined record can be shared again. Source identities are combined; suppression and holds on either contact are preserved.</p></section>`
 if (stale) return `${prefix}<p role="alert">These contacts changed after the submitted review. No merge was applied. Open a fresh review and confirm the current revisions before merging.</p>${facts([['Submitted keeper revision', view.draft?.revision ?? 'Unavailable'], ['Submitted other revision', view.draft?.otherRevision ?? 'Unavailable']])}${comparison}<p><a href="${e(reviewLink)}">Open fresh merge review</a></p>`
 return `${prefix}${comparison}${result}<details open><summary>Confirm exact merge</summary><p><a href="${e(switched)}">Use ${e(other.name)} as the keeper instead</a></p><p><a href="${path(contact)}/merge">Choose another contact</a></p><form method="post" action="${path(contact)}/merge">${hidden('revision', contact.revision)}${hidden('otherId', other.id)}${hidden('otherRevision', other.revision)}${checkbox('confirm', 'Merge these exact contacts and withdraw both records’ member read, edit, export and merge grants. Keep the selected keeper’s name, phone number, extension and timezone.', 'merge these exact contacts and withdraw read grants', false, true)}<button>Merge these exact contacts</button></form></details>`
}

export function directoryPage(view: DirectoryView) {
 const status = view.notice?.status ?? 200
 if (status === 503) return consolePage('Directory unavailable', boundary + '<p role="alert">The directory is temporarily unavailable. Retry to check current access and records.</p><p><a href="/app/directory">Retry directory</a></p>', 503)
 const notice = view.notice ? `<p role="${status >= 400 ? 'alert' : 'status'}">${e(view.notice.message)}</p>` : ''
 const title = view.creating ? 'Create contact' : view.merging ? 'Review contact merge' : view.editing ? 'Edit contact' : view.contact?.name ?? 'Directory'
 const body = view.creating ? createPage(view) : view.contact ? view.merging ? mergePage(view) : view.editing ? editPage(view) : detailPage(view) : listPage(view)
 return consolePage(title, notice + (view.completed ? '<p role="status">Directory change completed. Member grants were withdrawn; any company sharing requires a new explicit grant.</p>' : '') + body, status)
}

export function directoryDenied(status = 403) {
 return consolePage('Directory access needed', boundary + '<p role="alert">This directory request is unavailable with your current access. No contact details are shown.</p><p><a href="/app/directory">Return to directory</a></p><p><a href="/app">Return to workspace</a></p>', status)
}
