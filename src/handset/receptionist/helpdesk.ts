import type { Bindings } from '../../auth.server'
import { origin, send, bearer, held, rejected, uncertain, type EdgeResult } from './edge'

// HappyToHelp workspace API: a message with a caller-chosen localId lands once in the
// call's support conversation. HappyToHelp keeps the ticket, its procedures and status.
const base = (env: Bindings) => env.HANDSET_HELPDESK_TOKEN ? origin(env.HANDSET_HELPDESK_ORIGIN, 'helpdesk_origin') : null
export async function helpdeskNote(env: Bindings, conversationId: string, localId: string, content: string, beforeEffect: () => Promise<void> = async () => {}): Promise<EdgeResult> {
 const o = base(env)
 if (!o) return held('helpdesk_connector_unconfigured')
 const headers = { ...bearer(env.HANDSET_HELPDESK_TOKEN), 'content-type': 'application/json' }, path = `${o}/api/v1/conversations/${encodeURIComponent(conversationId)}`
 const readback = async (): Promise<EdgeResult> => {
  const read = await send(`${path}/messages`, { method: 'GET', headers })
  if (!read || read.status !== 200 || !Array.isArray(read.body.data)) return uncertain('helpdesk_readback_unavailable')
  const found = (read.body.data as Record<string, unknown>[]).filter(m => m.localId === localId)
  if (found.length > 1) return uncertain('helpdesk_duplicate_message')
  if (found.length !== 1 || found[0].content !== content) return uncertain('helpdesk_readback_mismatch')
  return { state: 'confirmed', externalId: String(found[0].id ?? localId), readback: { conversationId, localId, content }, reason: 'readback_matched' }
 }
 const existing = await readback()
 if (existing.state === 'confirmed') return existing
 for (let attempt = 0; attempt < 2; attempt++) {
  const conversation = await send(path, { method: 'GET', headers })
  if (!conversation) return uncertain('helpdesk_conversation_unreadable')
  if (conversation.status === 404 || conversation.status === 403) return rejected('helpdesk_conversation_out_of_scope')
  if (conversation.status !== 200) return uncertain('helpdesk_answer_unrecognised')
  await beforeEffect()
  const wire = await send(`${path}/messages`, { method: 'POST', headers, body: JSON.stringify({ localId, content, expectedRevision: conversation.body.revision }) })
  if (!wire) return uncertain('helpdesk_response_lost')
  if ([200, 201].includes(wire.status)) return readback()
  if (wire.status === 409 && attempt === 0) { const existing = await readback(); if (existing.state === 'confirmed') return existing; continue }
  if (wire.status === 401 || wire.status === 403) return rejected('helpdesk_credential_refused')
  return wire.status < 500 ? rejected('helpdesk_refused') : uncertain('helpdesk_answer_unrecognised')
 }
 return uncertain('helpdesk_revision_conflict_unsettled')
}
