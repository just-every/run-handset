import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { escape as e, Fault, id } from '../core'
import { callUrl, readTwilio } from '../consent/store'
import { activeSourceById, sourceFence } from '../providers/sources'
import type { Entry } from '../queues/model'
import { event, isStopped, policyFence, policyFor, recoveryEvent, root, type Callback, type Policy } from './model'

export const offerText = (p: Pick<Policy, 'business_name'>, language: string) => language.startsWith('es')
 ? `${p.business_name}: para conservar su lugar y recibir una llamada en este número, oprima 1. No perderá su turno.`
 : `${p.business_name}: to keep your place and get a call back at this number, press 1. You will not lose your place in line.`
export const holdPromptVersion = 'virtual-hold-v1'

/** Wait-loop addition for a queue whose owner approved caller-requested callbacks; otherwise nothing changes. */
export async function holdOffer(env: Bindings, binding: { id: string; source_id: string; queue_id: string }, row: Entry) {
 const p = await policyFor(env, binding.source_id)
 if (!p || p.queue_id !== row.queue_id || row.state !== 'waiting') return ''
 return `<Gather input="dtmf" numDigits="1" timeout="2" actionOnEmptyResult="false" action="${e(`${env.AUTH_ORIGIN}${root}/holds/${binding.id}/${row.id}`)}" method="POST"><Say language="${row.language.startsWith('es') ? 'es-MX' : 'en-US'}">${e(offerText(p, row.language))}</Say></Gather>`
}
const back = (env: Bindings, bindingId: string) => `<Redirect method="POST">${e(`${env.AUTH_ORIGIN}/providers/twilio/queues/${bindingId}`)}</Redirect>`
const goodbye = (language: string) => `<Say language="${language.startsWith('es') ? 'es-MX' : 'en-US'}">${language.startsWith('es') ? 'Conservamos su lugar. Le llamaremos a este número. Hasta pronto.' : 'We are keeping your place. We will call you back at this number. Goodbye.'}</Say><Hangup/>`

export async function holdDecision(env: Bindings, bindingId: string, entryId: string, p: URLSearchParams): Promise<string> {
 const binding = await env.DB.prepare(`SELECT b.* FROM hnd_queue_bindings b JOIN oa_operators o ON o.id=b.owner_id WHERE b.id=? AND b.revoked_at IS NULL AND o.version=b.owner_version AND o.status='active' AND o.role='owner'`).bind(bindingId).first<{ id: string; source_id: string; queue_id: string }>()
 if (!binding) throw new Fault('not_found', 404)
 const source = await activeSourceById(env, binding.source_id), policy = await policyFor(env, binding.source_id)
 if (!source || !policy || policy.queue_id !== binding.queue_id) throw new Fault('virtual_hold_not_approved', 409)
 if (p.get('AccountSid') !== source.account_id) throw new Fault('callback_account_mismatch', 403)
 const row = await env.DB.prepare('SELECT * FROM hnd_queue_entries WHERE id=? AND origin_queue_id=?').bind(entryId, binding.queue_id).first<Entry & { queued_at: number }>()
 if (!row) throw new Fault('not_found', 404)
 const call = await env.DB.prepare("SELECT r.case_id,r.data,o.external_id AS call_sid FROM hnd_records r JOIN hnd_source_objects o ON o.record_id=r.id WHERE r.id=? AND r.kind='call_session' AND o.source_id=?").bind(row.call_id, source.id).first<{ case_id: string; data: string; call_sid: string }>()
 if (!call) throw new Fault('verified_call_required', 409)
 const data = JSON.parse(call.data) as { from: string; to: string; direction: string }
 if (p.get('CallSid') !== call.call_sid || p.get('From') !== data.from || p.get('To') !== data.to || data.direction !== 'inbound') throw new Fault('callback_call_identity_mismatch', 403)
 const prior = await env.DB.prepare('SELECT id FROM hnd_callbacks WHERE queue_entry_id=?').bind(entryId).first()
 if (prior) return goodbye(row.language)
 if (p.get('Digits') !== '1' || row.state !== 'waiting') return back(env, bindingId)
 if (await isStopped(env, data.from, source.number_id)) return back(env, bindingId)
 // The caller's key press must belong to a call that is still up, read from the carrier's own resource.
 const live = await readTwilio(env, source, callUrl(source, call.call_sid))
 if (live.sid !== call.call_sid || live.account_sid !== source.account_id || live.from !== data.from || live.to !== data.to || live.direction !== 'inbound' || !['ringing', 'in-progress'].includes(String(live.status))) throw new Fault('existing_inbound_call_required', 409)
 const now = Date.now(), key = id(), prompt = offerText(policy, row.language)
 const consent = { kind: 'dtmf', digits: '1', purpose: 'callback', language: row.language, promptVersion: holdPromptVersion, prompt, callSid: call.call_sid, caller: data.from, business: data.to, queueEntryId: row.id, serverTimestamp: now, source: 'signed Twilio Gather', legalBasis: 'The caller asked for a call back at the number they are calling from; no marketing enrollment.', marketingEnrollment: false }
 const recovery = await env.DB.prepare("SELECT id FROM hnd_recovery WHERE case_id=? AND state NOT IN ('resolved','declined')").bind(call.case_id).first<{ id: string }>(), recoveryId = recovery?.id ?? id()
 const place = JSON.stringify({ id: row.id, queue_id: row.queue_id, origin_queue_id: row.origin_queue_id, queued_at: row.queued_at, priority: row.priority, current_visit_id: row.current_visit_id })
 const cb: Callback = { id: key, recovery_id: recoveryId, case_id: call.case_id, source_id: source.id, queue_id: row.queue_id, queue_entry_id: row.id, kind: 'virtual_hold', recipient: data.from, queued_at: row.queued_at, priority: row.priority, due_at: now, state: 'waiting', attempts: 0, reason: 'Caller left the line and keeps the retained queue place', consent: JSON.stringify(consent), owner_id: policy.approved_by, owner_version: policy.owner_version, revision: 1, created_at: now, updated_at: now }
 await append(env, source.id, 'callback.hold', key, 'completed', [sourceFence(env, source), policyFence(env, policy),
  env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_queue_entries WHERE id=? AND state='waiting' AND revision=?").bind(row.id, row.revision),
  env.DB.prepare('DELETE FROM hnd_queue_reservations WHERE entry_id=?').bind(row.id),
  env.DB.prepare("UPDATE hnd_queue_entries SET state='abandoned',agent_id=NULL,ended_at=?,reason='virtual_hold',revision=revision+1 WHERE id=?").bind(now, row.id),
  env.DB.prepare('INSERT INTO hnd_queue_events(id,queue_id,entry_id,agent_id,type,occurred_at,payload) VALUES (?,?,?,NULL,?,?,?)').bind(id(), row.queue_id, row.id, 'entry.virtual_hold', now, JSON.stringify({ callbackId: key, queuedAt: row.queued_at, priority: row.priority, meaning: 'caller left the line; place retained for callback order' })),
  ...(recovery ? [] : [env.DB.prepare('INSERT INTO hnd_recovery VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(recoveryId, call.case_id, source.id, row.call_id, row.id, place, data.from, policy.approved_by, policy.owner_version, 'open', now + 3600000, policy.max_attempts, 'Virtual hold: owned callback awaiting its retained place', null, 1, now, now), recoveryEvent(env, recoveryId, 'opened', { callRecordId: row.call_id, queuePlace: JSON.parse(place), virtualHold: true }, source.id, now),env.DB.prepare("INSERT INTO hnd_recovery_links SELECT ?,id FROM hnd_recovery WHERE case_id=? AND id<>? AND state IN ('resolved','declined') ORDER BY created_at DESC,rowid DESC LIMIT 1").bind(recoveryId,call.case_id,recoveryId)]),
  env.DB.prepare(`INSERT INTO hnd_callbacks(${Object.keys(cb).join(',')}) VALUES (${Object.keys(cb).map(() => '?').join(',')})`).bind(...Object.values(cb)),
  event(env, key, 'held', { consent, queuePlace: JSON.parse(place) }, now)], null, sourcePolicy(source))
 return goodbye(row.language)
}
