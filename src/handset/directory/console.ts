import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { denied } from '../audit/store'
import { Fault, keys, type ObjectValue } from '../core'
import { directoryDoor } from './doors'
import { directoryPage, directoryDenied, type DirectoryContact, type DirectoryView } from './pages'

const base = '/app/directory'
const conflict = 'This contact changed. Your entries are retained. Compare the current record before explicitly applying your reviewed changes.'
const refusals: Record<string, string> = {
 contact_revision_conflict: conflict,
 invalid_regional_number: 'Enter a valid phone number with its international calling code. Your entries are retained.',
 explicit_calling_code_required: 'Include the international calling code. Add an extension after x if needed. Your entries are retained.',
 invalid_timezone: 'Enter a recognized timezone, or leave it empty when unknown. Your entries are retained.',
 merge_confirmation_required: 'Review both exact contacts and confirm withdrawal of both records’ member grants.',
}

/** Forms use the same current authority and atomic revision checks as direct requests. */
export async function directoryConsole(request: Request, env: Bindings, actor: Session, raw?: ObjectValue): Promise<Response> {
 const url = new URL(request.url), suffix = url.pathname.slice(base.length)
 const match = suffix.match(/^\/([0-9a-f-]{36})(?:\/(edit|merge))?$/)
 const creating = suffix === '/new', contactId = match?.[1], action = match?.[2]
 if (suffix !== '' && !creating && !match) throw new Fault('not_found', 404)
 if (!['GET', 'POST'].includes(request.method) || request.method === 'POST' && !creating && !action) throw new Fault('method_not_allowed', 405)
 const api = async (path: string, value?: ObjectValue) => directoryDoor(new Request(new URL('/api/handset/directory' + path, url), { method: value ? 'POST' : 'GET' }), env, actor, value)
 const view: DirectoryView = { contacts: [], creating, editing: action === 'edit', merging: action === 'merge', isOwner: actor.operator.role === 'owner' }
 const load = async () => {
  if (contactId) view.contact = (await (await api('/contacts/' + contactId)).json() as { contact: DirectoryContact }).contact
  if (!creating && (!contactId || action === 'merge')) view.contacts = (await (await api('/contacts')).json() as { contacts: DirectoryContact[] }).contacts
  const otherId = request.method === 'POST' ? raw?.otherId : url.searchParams.get('otherId')
  if (otherId) view.other = view.contacts.find(c => c.id === otherId && c.id !== contactId)
  if (view.editing && !view.contact?.capabilities.edit || view.merging && (!view.contact?.capabilities.merge || view.contact.visibility !== 'company')) throw new Fault('directory_capability_required', 403)
  if (otherId && (!view.other || !view.other.capabilities.merge || view.other.visibility !== 'company')) throw new Fault('directory_capability_required', 403)
 }
 try {
  await load()
  if (request.method === 'GET') {
   view.completed = url.searchParams.get('completed') === 'withdrawn'
   return directoryPage(view)
  }
  if (!raw) throw new Fault('invalid_object')
  try {
   let value: ObjectValue
   if (creating) {
    keys(raw, ['name', 'number', 'timezone', 'visibility', 'sources', 'suppressed', 'held'])
    if (typeof raw.sources !== 'string') throw new Fault('invalid_sources')
    value = { ...raw, sources: raw.sources.split(/\r?\n/).map(s => s.trim()).filter(Boolean), suppressed: Number(raw.suppressed ?? 0), held: Number(raw.held ?? 0) }
   } else if (action === 'edit') {
    keys(raw, ['revision', 'name', 'number', 'timezone', 'reconcile', 'freshRevision'])
    let revision = Number(raw.revision)
    if (raw.reconcile !== undefined || raw.freshRevision !== undefined) {
     if (raw.reconcile !== 'apply reviewed changes' || Number(raw.freshRevision) !== view.contact!.revision) throw new Fault('contact_revision_conflict', 409)
     revision = Number(raw.freshRevision)
    }
    value = { revision, name: raw.name, number: raw.number, timezone: raw.timezone }
   } else {
    keys(raw, ['revision', 'otherId', 'otherRevision', 'confirm'])
    value = { ...raw, revision: Number(raw.revision), otherRevision: Number(raw.otherRevision) }
   }
   const result = await (await api(creating ? '/contacts' : '/contacts/' + contactId + (action === 'merge' ? '/merge' : ''), value)).json() as { contact?: DirectoryContact; contactId?: string; grantsWithdrawn?: boolean }
   const location = result.contact ? base + '/' + result.contact.id + (result.grantsWithdrawn ? '?completed=withdrawn' : '') : base + '?completed=withdrawn'
   return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } })
  } catch (error) {
   if (!(error instanceof Fault)) throw error
   await denied(env, actor, 'product.request')
   // Re-read before reflecting submitted values; a lost grant must not echo private data.
   await load()
   view.draft = raw
   view.notice = { status: error.status, message: refusals[error.code] ?? error.code.replaceAll('_', ' ') + '. Your entries are retained; nothing was changed.' }
   return directoryPage(view)
  }
 } catch (error) {
  if (!(error instanceof Fault)) {
   console.error('Directory request failed', error instanceof Error ? error.name : 'unknown')
   return directoryPage({ contacts: [], creating: false, editing: false, merging: false, isOwner: false, notice: { status: 503, message: 'Directory unavailable' } })
  }
  if ([401, 403].includes(error.status)) {
   await denied(env, actor, 'product.request')
   return directoryDenied(error.status)
  }
  throw error
 }
}
