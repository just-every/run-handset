import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { actorRef, append, commit } from '../audit/store'
import { Fault, id, integer, json, keys, owner, ownerFence, text, timestamp, type ObjectValue } from '../core'
import { activeSourceById, sourceFence } from '../providers/sources'
import type { RecordRow } from '../records/model'
import { recoveryNeed } from './needs'
import { accessGrant, assigneeAuthority, accessSnapshot, grantRecovery, recoverLostAuthority, recoveryAuthority, revokeRecovery, type Capability } from './access'
import { schedule, change as changeCallback } from '../callbacks/doors'
import type { Callback } from '../callbacks/model'
import { configureIntake, intakeSnapshot, revokeIntake } from './intake-policy'

interface Recovery {
 id: string; case_id: string; source_id: string; call_record_id: string; queue_entry_id: string | null;
 queue_place: string; recipient: string; owner_id: string; owner_version: number; state: string;
 due_at: number; max_attempts: number; reason: string; resolution: string | null;
 revision: number; created_at: number; updated_at: number
}
const get = async (env: Bindings, key: string) => {
 const row = await env.DB.prepare('SELECT * FROM hnd_recovery WHERE id=?').bind(key).first<Recovery>()
 if (!row) throw new Fault('recovery_not_found', 404)
 return row
}
const event = (env: Bindings, actor: Session, key: string, kind: string, evidence: unknown) => env.DB.prepare('INSERT INTO hnd_recovery_events VALUES (?,?,?,?,?,?)').bind(id(), key, kind, JSON.stringify(evidence), actor.operator.id, Date.now())
const fence = (env: Bindings, row: Recovery) => env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_recovery WHERE id=? AND revision=?').bind(row.id, row.revision)
async function create(env: Bindings, actor: Session, v: ObjectValue) {
 keys(v, ['callRecordId','dueAt','maxAttempts','queueEntryId'])
 const callId = text(v.callRecordId, 'callRecordId')
 const record = await env.DB.prepare(`SELECT r.*,s.source_id AS verified_source_id FROM hnd_records r JOIN hnd_record_sources s ON s.record_id=r.id WHERE r.id=? AND r.kind IN ('call_session','call_leg','provider_attempt') AND s.source_kind='twilio'`).bind(callId).first<RecordRow & {verified_source_id: string}>()
 if (!record || !record.case_id) throw new Fault('verified_missed_call_required', 409)
 const data = JSON.parse(record.data) as {direction?: string; providerStatus?: string; from?: string; to?: string}
 if (data.direction !== 'inbound' || !['no-answer','busy','failed','canceled'].includes(data.providerStatus ?? '')) throw new Fault('verified_unanswered_leg_required', 409)
 const source = await activeSourceById(env, record.verified_source_id)
 if (!source) throw new Fault('source_inactive', 409)
 const recipient = text(data.from, 'recipient', 30)
 if (!/^\+[1-9]\d{7,14}$/.test(recipient)) throw new Fault('recipient_unknown', 409)
 const need=await recoveryNeed(env,record.case_id,callId)
 if(need.existing) {
  if(need.mapping.length)await commit(env,actor,'recovery.create',need.id,'completed',[sourceFence(env,source),...need.fences,...need.mapping])
  return {recovery:await get(env,need.id),replay:true,launched:0}
 }
 const dueAt = timestamp(v.dueAt, 'dueAt'), max = integer(v.maxAttempts ?? 1, 'maxAttempts', 1, 3)
 let place: unknown = {}, queueEntryId: string | null = null
 if (v.queueEntryId) {
  queueEntryId = text(v.queueEntryId, 'queueEntryId')
  const entry = await env.DB.prepare(`SELECT e.id,e.queue_id,e.origin_queue_id,e.queued_at,e.priority,e.current_visit_id FROM hnd_queue_entries e JOIN hnd_records r ON r.id=e.call_id WHERE e.id=? AND r.case_id=?`).bind(queueEntryId, record.case_id).first()
  if (!entry) throw new Fault('queue_place_not_this_need', 409)
  place = entry
 }
 const stopped = await env.DB.prepare("SELECT id FROM hnd_protection_stops WHERE recipient=? AND (number_id=? OR reason='dnc') AND channel IN ('voice','all') LIMIT 1").bind(recipient, source.number_id).first()
 const now = Date.now(), key = need.id
 const row: Recovery = { id: key, case_id: record.case_id, source_id: source.id, call_record_id: callId, queue_entry_id: queueEntryId,
  queue_place: JSON.stringify(place), recipient, owner_id: actor.operator.id, owner_version: actor.operator.version,
  state: stopped ? 'stopped' : 'open', due_at: dueAt, max_attempts: max, reason: stopped ? 'Current opt-out or DNC suppresses contact' : 'Owned recovery; text and callback await qualified authority', resolution: null, revision: 1, created_at: now, updated_at: now }
 await commit(env, actor, 'recovery.create', key, 'completed', [sourceFence(env, source), ...need.fences,
  env.DB.prepare(`INSERT INTO hnd_recovery(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)), ...need.mapping, event(env, actor, key, 'opened', { callRecordId: callId, queuePlace: place, suppressed: !!stopped }),
 ])
 return { recovery: row, replay: false, launched: 0 }
}
async function act(env: Bindings, actor: Session, row: Recovery, op: string, v: ObjectValue) {
 const guards: D1PreparedStatement[] = await recoveryAuthority(env,actor,row,({assign:'assign',takeover:'takeover',stop:'stop',decline:'decline','callback-proposal':'schedule'} as Record<string,Capability>)[op]??'work')
 if (integer(v.revision, 'revision', 1) !== row.revision) throw new Fault('recovery_revision_conflict', 409)
 if (!['open','human','escalated'].includes(row.state)) throw new Fault('recovery_already_terminal', 409)
 let state = row.state, dueAt = row.due_at, reason = row.reason, resolution = row.resolution, assigned = row.owner_id, ownerVersion = row.owner_version
 if (op === 'resolve') {
  keys(v, ['revision','outcomeId'])
  const outcomeId = text(v.outcomeId, 'outcomeId')
  const booking = await env.DB.prepare("SELECT s.id,s.external_id,s.readback FROM hnd_rx_steps s JOIN hnd_rx_outcomes o ON o.id=s.outcome_id WHERE o.id=? AND o.case_id=? AND s.kind='booking' AND s.state='confirmed' AND s.updated_at>=? AND NOT EXISTS(SELECT 1 FROM hnd_recovery prior WHERE prior.id<>? AND (json_extract(prior.resolution,'$.stepId')=s.id OR json_extract(prior.resolution,'$.outcomeId')=o.id))").bind(outcomeId, row.case_id, row.created_at, row.id).first<{id: string; external_id: string; readback: string}>()
  if (!booking) throw new Fault('confirmed_same_case_booking_required', 409)
  // No arbitrary done flag: only the outcome runtime's independently read-back booking.
  state = 'resolved'; reason = 'Confirmed booking from the same customer case'; resolution = JSON.stringify({ outcomeId, stepId: booking.id, externalId: booking.external_id, readback: JSON.parse(booking.readback) })
  guards.push(env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_rx_steps WHERE id=? AND state='confirmed' AND NOT EXISTS(SELECT 1 FROM hnd_recovery used WHERE json_extract(used.resolution,'$.outcomeId')=?)").bind(booking.id,outcomeId))
 } else if (op === 'assign') {
  keys(v, ['revision','ownerId','note']); assigned = text(v.ownerId, 'ownerId'); reason = text(v.note, 'note', 1000)
  const person = await env.DB.prepare("SELECT version,role FROM oa_operators WHERE id=? AND status='active'").bind(assigned).first<{version: number;role:string}>()
  if (!person) throw new Fault('active_person_required', 403)
  if(person.role!=='owner')guards.push(...await assigneeAuthority(env,assigned,row.source_id,'work'))
  ownerVersion = person.version
  guards.push(env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status='active'").bind(assigned, ownerVersion))
 } else if (op === 'callback-proposal') {
  keys(v, ['revision','timezone','dueAt'])
  if (row.state !== 'open') throw new Fault('human_takeover_blocks_automation', 409)
  const timezone = text(v.timezone, 'timezone', 80)
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }) } catch { throw new Fault('invalid_timezone') }
  dueAt = timestamp(v.dueAt, 'dueAt')
  const source = await activeSourceById(env, row.source_id)
  if (!source) throw new Fault('source_inactive', 409)
  const stop = await env.DB.prepare("SELECT id FROM hnd_protection_stops WHERE recipient=? AND (number_id=? OR reason='dnc') AND channel IN ('voice','all') LIMIT 1").bind(row.recipient, source.number_id).first()
  if (stop) { state = 'stopped'; reason = 'Current opt-out or DNC suppresses contact' }
  else { reason = `Callback proposal only in ${timezone}; qualified dialer list, licensed registry checks, current consent, local hours, grant and USD cap required. No dial started.` }
  guards.push(sourceFence(env, source))
 } else {
  keys(v, ['revision','note'])
  reason = text(v.note, 'note', 1000)
  if (op === 'takeover') state = 'human'
  else if (op === 'stop') state = 'stopped'
  else if (op === 'decline') state = 'declined'
  else if (op === 'escalate') {
   if (row.due_at > Date.now()) throw new Fault('not_due', 409)
   state = 'escalated'
  } else throw new Fault('not_found', 404)
 }
 await commit(env, actor, 'recovery.change', row.id, 'completed', [fence(env, row), ...guards,
  env.DB.prepare('UPDATE hnd_recovery SET state=?,due_at=?,reason=?,resolution=?,owner_id=?,owner_version=?,revision=revision+1,updated_at=? WHERE id=?').bind(state, dueAt, reason, resolution, assigned, ownerVersion, Date.now(), row.id), event(env, actor, row.id, op, { previousState: row.state, state, reason, resolution: resolution ? JSON.parse(resolution) : null }),
  ...(['takeover','stop','decline'].includes(op)?[env.DB.prepare("UPDATE hnd_callbacks SET state='cancelled',reason='Recovery taken over or stopped; no unstarted dial',revision=revision+1 WHERE recovery_id=? AND state='waiting'").bind(row.id)]:[]),
 ],false)
 return { recovery: await get(env, row.id), launched: 0, customerContact: 'held' }
}
export async function recoveryDoor(request: Request, env: Bindings, actor: Session, value?: ObjectValue): Promise<Response | null> {
 const path = new URL(request.url).pathname, base = '/api/handset/recovery'
 if (path !== base && !path.startsWith(base + '/')) return null
 if (path === base && request.method === 'GET') {
  const candidates=(await env.DB.prepare('SELECT * FROM hnd_recovery WHERE (?=1 OR owner_id=?) ORDER BY due_at,id LIMIT 200').bind(actor.operator.role==='owner'?1:0,actor.operator.id).all<Recovery>()).results
  const rows=[];const guards:D1PreparedStatement[]=actor.operator.role==='owner'?[ownerFence(env.DB,actor)]:[]
  for(const row of candidates){try{guards.push(...await recoveryAuthority(env,actor,row,'read'));rows.push(row)}catch(error){if(!(error instanceof Fault&&error.status===403))throw error}}
  if(actor.operator.role!=='owner'&&!rows.length)throw new Fault('recovery_capability_required',403)
  const cases:Record<string,unknown>[]=[]
  for(const row of rows)cases.push({...row,previous_id:(await env.DB.prepare('SELECT previous_id FROM hnd_recovery_links WHERE recovery_id=?').bind(row.id).first<{previous_id:string}>())?.previous_id??null,missedCalls:(await env.DB.prepare("SELECT evidence FROM hnd_recovery_events WHERE recovery_id=? AND kind='missed_observed' ORDER BY created_at,id").bind(row.id).all()).results.map(r=>JSON.parse(String(r.evidence))),waitingCallback:(await env.DB.prepare("SELECT id,revision,reason FROM hnd_callbacks WHERE recovery_id=? AND state='waiting' ORDER BY created_at DESC LIMIT 1").bind(row.id).first()),capabilities:actor.operator.role==='owner'?['read','work','takeover','stop','decline','schedule','cancel','assign']:(await env.DB.prepare('SELECT number_id FROM hnd_sources WHERE id=?').bind(row.source_id).first<{number_id:string}>())!.number_id})
  for(const row of cases)if(typeof row.capabilities==='string'){const n=row.capabilities;row.capabilities=[];for(const c of ['read','work','takeover','stop','decline','schedule','cancel','assign'] as Capability[])if(await accessGrant(env,actor.operator.id,n,c))(row.capabilities as string[]).push(c)}
  await commit(env,actor,'recovery.request','installation','completed',guards,false)
  return json({cases,truncated:rows.length===200,overdue:rows.filter(r=>['open','human','escalated'].includes(r.state)&&r.due_at<=Date.now()).length,owner:actor.operator.role==='owner',...(actor.operator.role==='owner'?await intakeSnapshot(env):{}),...await accessSnapshot(env,actor)})
 }
 if (request.method !== 'POST' || !value) throw new Fault('method_not_allowed', 405)
 if(path===base+'/access'){owner(actor);return json(await grantRecovery(env,actor,value),201)}
 if(path===base+'/access/revoke'){owner(actor);return json(await revokeRecovery(env,actor,value))}
 if(path===base+'/policies'||path===base+'/policies/revoke'||path===base)owner(actor)
 if (path === base + '/policies') return json(await configureIntake(env, actor, value), 201)
 if (path === base + '/policies/revoke') return json(await revokeIntake(env, actor, value))
 if (path === base) { const result = await create(env, actor, value); return json(result, result.replay ? 200 : 201) }
 const action=path.slice(base.length).match(/^\/([0-9a-f-]{36})\/(requested-callback|cancel-callback)$/)
 if(action){const row=await get(env,action[1]);if(action[2]==='requested-callback')return json(await schedule(env,actor,{...value,recoveryId:row.id}),201);const cb=await env.DB.prepare("SELECT * FROM hnd_callbacks WHERE recovery_id=? AND state='waiting' ORDER BY created_at DESC LIMIT 1").bind(row.id).first<Callback>();if(!cb)throw new Fault('waiting_callback_required',409);return json(await changeCallback(env,actor,cb,'cancel',value))}
 const m = path.slice(base.length).match(/^\/([0-9a-f-]{36})\/(takeover|stop|assign|decline|resolve|escalate|callback-proposal)$/)
 if (!m) throw new Fault('not_found', 404)
 return json(await act(env, actor, await get(env, m[1]), m[2], value))
}

/** The scheduler escalates owned overdue work. It never launches or retries contact. */
export async function tickRecovery(env: Bindings, at = Date.now()) {
 await recoverLostAuthority(env)
 const rows = (await env.DB.prepare("SELECT r.* FROM hnd_recovery r JOIN oa_operators o ON o.id=r.owner_id WHERE r.state IN ('open','human') AND r.due_at<=? AND o.status='active' AND o.role='owner' AND o.version=r.owner_version ORDER BY r.due_at LIMIT 100").bind(at).all<Recovery>()).results
 let escalated = 0
 for (const row of rows) {
  try {
   await append(env, await actorRef(env.DB, row.owner_id), 'recovery.change', row.id, 'completed', [fence(env, row),
    env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND role='owner' AND status='active' AND version=?").bind(row.owner_id, row.owner_version),
    env.DB.prepare("UPDATE hnd_recovery SET state='escalated',reason='Overdue recovery requires the named owner; no automatic contact',revision=revision+1,updated_at=? WHERE id=?").bind(at, row.id),
    env.DB.prepare('INSERT INTO hnd_recovery_events VALUES (?,?,?,?,?,?)').bind(id(), row.id, 'overdue', JSON.stringify({ dueAt: row.due_at, priorState: row.state, ownerId: row.owner_id }), row.owner_id, at),
   ])
   escalated++
  } catch (error) { if (!(error instanceof Fault && error.code === 'state_changed')) throw error }
 }
 return { escalated, launched: 0 }
}
