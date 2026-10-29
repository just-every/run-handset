import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { choice, Fault, id, integer, json, keys, object, owner, text, timestamp, type ObjectValue } from '../core'
import { activeSourceById, sourceFence } from '../providers/sources'
import { send } from '../receptionist/edge'
const kinds = ['port_pin','e911_move','brand_registration','tollfree_verification','reputation'] as const
const plans = {
 port_pin: 'Request the correct PIN through the private carrier channel; obtain signed exact-number LOA and port approval; preserve source service until qualified cutover.',
 e911_move: 'Ask the employee to confirm the dispatchable location; validate it with the emergency carrier before changing active emergency service.',
 brand_registration: 'Prepare the rejected business facts for direct representative attestation and permitted receiving-carrier correction; sender remains unqualified.',
 tollfree_verification: 'Review rejection with the named representative; obtain attested facts and receiving-carrier verification before enabling this sender.',
 reputation: 'Gather per-network observations and follow the provider remediation case. Free Caller Registry is direct business-representative submission only. No replacement purchase or rotation without exact human authority; preserve consent and number obligations.',
}
export interface Compliance { id: string; source_id: string; number_id: string; kind: keyof typeof plans; reference: string; report: string; owner_id: string; owner_version: number; due_at: number; status: string; plan: string; approval_note: string; provider_state: string; readback: string | null; revision: number; created_at: number; updated_at: number }
const event = (env: Bindings, actor: Session, key: string, kind: string, evidence: unknown) => env.DB.prepare('INSERT INTO hnd_number_compliance_events VALUES (?,?,?,?,?,?,?)').bind(id(), key, kind, JSON.stringify(evidence), actor.operator.id, actor.operator.version, Date.now())
async function create(env: Bindings, actor: Session, v: ObjectValue) {
 keys(v, ['sourceId','kind','report','dueAt','confirm'])
 if (v.confirm !== 'prepare exact compliance case') throw new Fault('explicit_preparation_required')
 const source = await activeSourceById(env, text(v.sourceId, 'sourceId'))
 if (!source) throw new Fault('source_inactive', 409)
 const kind = choice(v.kind, kinds, 'kind'), report = object(v.report)
 let reference: string
 if (kind === 'port_pin') {
  keys(report, ['port_in_request_sid','phone_number_sid','port_in_phone_number_sid','port_in_phone_number_status','rejection_reason'])
  if(report.phone_number_sid!==undefined&&report.port_in_phone_number_sid!==undefined)throw new Fault('ambiguous_port_number_identity')
  reference = text(report.port_in_request_sid, 'portRequestId', 100) + '/' + text(report.phone_number_sid??report.port_in_phone_number_sid, 'portNumberId', 100)
  if (report.rejection_reason !== 'INVALID_PIN' || report.port_in_phone_number_status !== 'port_rejected') throw new Fault('wrong_pin_rejection_required')
 } else if (kind === 'brand_registration' || kind === 'tollfree_verification') {
  keys(report, kind === 'brand_registration' ? ['sid','account_sid','status','failure_reason'] : ['sid','account_sid','tollfree_phone_number','status','rejection_reason','error_code'])
  if (report.account_sid !== source.account_id || kind === 'tollfree_verification' && report.tollfree_phone_number !== source.e164) throw new Fault('receipt_mapping_out_of_scope', 403)
  reference = text(report.sid, 'receiptId', 100); text(report.status, 'status', 80)
  for (const field of ['failure_reason','rejection_reason']) if (report[field] !== undefined && report[field] !== null) text(report[field], field, 2000)
  if (kind === 'tollfree_verification' && report.error_code !== undefined && report.error_code !== null) integer(report.error_code, 'error_code', 0, 1000000)
 } else if (kind === 'e911_move') {
  keys(report, ['endpointId','locationRecordId','changeNoticeRecordId'])
  reference = text(report.endpointId, 'endpointId')
  for (const [field, recordKind] of [['endpointId','endpoint'],['locationRecordId','location'],['changeNoticeRecordId','comment']]) {
   if (!await env.DB.prepare('SELECT id FROM hnd_records WHERE id=? AND kind=?').bind(text(report[field], field), recordKind).first()) throw new Fault('cited_move_notice_required', 409)
  }
 } else {
  keys(report, ['network','observedAt','label','evidenceRecordId'])
  const network = text(report.network, 'network', 120), observedAt = timestamp(report.observedAt, 'observedAt')
  text(report.label, 'label', 120)
  const evidence = text(report.evidenceRecordId, 'evidenceRecordId')
  if (!await env.DB.prepare('SELECT id FROM hnd_records WHERE id=?').bind(evidence).first()) throw new Fault('cited_observation_required', 409)
  reference = network + ':' + observedAt
 }
 const old = await env.DB.prepare('SELECT * FROM hnd_number_compliance WHERE number_id=? AND kind=? AND reference=?').bind(source.number_id, kind, reference).first<Compliance>()
 if (old) {
  if (old.report !== JSON.stringify(report)) throw new Fault('reported_receipt_conflict', 409)
  return { case: old, replay: true, effectOccurred: false }
 }
 const key = id(), dueAt = timestamp(v.dueAt, 'dueAt'), now = Date.now()
 await commit(env, actor, 'compliance.prepare', key, 'completed', [sourceFence(env, source),
  env.DB.prepare("INSERT INTO hnd_number_compliance VALUES (?,?,?,?,?,?,?,?,?,'prepared',?,'','unknown',NULL,1,?,?)").bind(key, source.id, source.number_id, kind, reference, JSON.stringify(report), actor.operator.id, actor.operator.version, dueAt, plans[kind], now, now),
  event(env, actor, key, 'prepared', { kind, reportedReceipt: report, trust: 'Owner-supplied observation; provider readback pending' }),
 ])
 return { case: await env.DB.prepare('SELECT * FROM hnd_number_compliance WHERE id=?').bind(key).first(), replay: false, effectOccurred: false }
}
export async function complianceDoor(request: Request, env: Bindings, actor: Session, v?: ObjectValue): Promise<Response | null> {
 const base = '/api/handset/compliance', path = new URL(request.url).pathname
 if (path !== base && !path.startsWith(base + '/')) return null
 owner(actor)
 if (path === base && request.method === 'GET') return json({ cases: (await env.DB.prepare('SELECT * FROM hnd_number_compliance ORDER BY due_at,id LIMIT 200').all()).results, limit: 200, cleanCompliance: false, cleanReputation: false })
 const detail=path.slice(base.length).match(/^\/([0-9a-f-]{36})$/)
 if(request.method==='GET'&&detail){
  const row=await env.DB.prepare('SELECT * FROM hnd_number_compliance WHERE id=?').bind(detail[1]).first<Compliance>()
  if(!row)throw new Fault('compliance_case_not_found',404)
  await commit(env,actor,'compliance.readback',row.id,'completed')
  return json({case:row,events:(await env.DB.prepare('SELECT * FROM hnd_number_compliance_events WHERE case_id=? ORDER BY created_at,id').bind(row.id).all()).results,cleanCompliance:false,cleanReputation:false})
 }
 if (request.method !== 'POST' || !v) throw new Fault('method_not_allowed', 405)
 if (path === base) { const result = await create(env, actor, v); return json(result, result.replay ? 200 : 201) }
 const match = path.slice(base.length).match(/^\/([0-9a-f-]{36})\/(review|readback|submit|follow-up)$/)
 if (!match) throw new Fault('not_found', 404)
 const row = await env.DB.prepare('SELECT * FROM hnd_number_compliance WHERE id=?').bind(match[1]).first<Compliance>()
 if (!row) throw new Fault('compliance_case_not_found', 404)
 const revision = integer(v.revision, 'revision', 1)
 if (revision !== row.revision) throw new Fault('compliance_revision_conflict', 409)
 const source = await activeSourceById(env, row.source_id)
 if (!source) throw new Fault('source_inactive', 409)
 const fence = env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_number_compliance WHERE id=? AND revision=?').bind(row.id, revision)
 if (!['readback','follow-up'].includes(match[2]) && (actor.operator.id !== row.owner_id || actor.operator.version !== row.owner_version)) throw new Fault('named_compliance_owner_required', 403)
 if(match[2]==='follow-up'){
  keys(v,['revision','ownerId','dueAt','nextAction','confirm'])
  if(v.confirm!=='assign exact continued follow-up')throw new Fault('explicit_followup_required')
  const ownerId=text(v.ownerId,'ownerId'),dueAt=timestamp(v.dueAt,'dueAt'),nextAction=text(v.nextAction,'nextAction',2000)
  if(dueAt<=Date.now())throw new Fault('future_followup_required')
  const person=await env.DB.prepare("SELECT version FROM oa_operators WHERE id=? AND status='active' AND role='owner'").bind(ownerId).first<{version:number}>()
  if(!person)throw new Fault('active_compliance_owner_required',403)
  await commit(env,actor,'compliance.followup',row.id,'completed',[fence,sourceFence(env,source),
   env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND status='active' AND role='owner' AND version=?").bind(ownerId,person.version),
   env.DB.prepare("UPDATE hnd_number_compliance SET status='follow_up',owner_id=?,owner_version=?,due_at=?,revision=revision+1,updated_at=? WHERE id=?").bind(ownerId,person.version,dueAt,Date.now(),row.id),
   event(env,actor,row.id,'follow_up',{previousOwner:row.owner_id,previousDueAt:row.due_at,ownerId,ownerVersion:person.version,dueAt,nextAction,effectAuthority:false}),
  ])
 } else if (match[2] === 'review') {
  keys(v, ['revision','note','confirm'])
  if (v.confirm !== 'review exact correction preparation') throw new Fault('exact_review_required')
  const note = text(v.note, 'note', 2000)
  await commit(env, actor, 'compliance.review', row.id, 'completed', [fence, sourceFence(env, source), env.DB.prepare("UPDATE hnd_number_compliance SET status='reviewed',approval_note=?,revision=revision+1,updated_at=? WHERE id=?").bind(note, Date.now(), row.id), event(env, actor, row.id, 'reviewed', { note, effectAuthority: false })])
 } else if (match[2] === 'submit') {
  keys(v, ['revision'])
  await commit(env, actor, 'compliance.submit', row.id, 'refused', [fence, sourceFence(env, source), event(env, actor, row.id, 'held', { reason: 'No qualified filing, LOA, location, rotation or spend adapter; preparation review is not legal attestation or effect authority' })])
  return json({ id: row.id, state: 'held', effectOccurred: false, reason: 'Qualified filing, exact signed LOA, validated location or rotation or spend authority required; no carrier mutation' }, 202)
 } else {
  keys(v, ['revision','confirm'])
  if (v.confirm !== 'read exact compliance receipt') throw new Fault('exact_receipt_read_required')
  let url: string
  const report = JSON.parse(row.report) as Record<string, string>
  if (row.kind === 'port_pin') url = `https://numbers.twilio.com/v1/Porting/PortIn/${encodeURIComponent(report.port_in_request_sid)}/PhoneNumber/${encodeURIComponent(report.phone_number_sid??report.port_in_phone_number_sid)}`
  else if (row.kind === 'brand_registration') url = `https://messaging.twilio.com/v1/a2p/BrandRegistrations/${encodeURIComponent(report.sid)}`
  else if (row.kind === 'tollfree_verification') url = `https://messaging.twilio.com/v1/Tollfree/Verifications/${encodeURIComponent(report.sid)}`
  else return json({ id: row.id, state: 'held', reason: 'Qualified provider, employee and network readback pending; case remains due', effectOccurred: false }, 202)
  const wire = await send(url, { method: 'GET', headers: { authorization: 'Basic ' + btoa(source.account_id + ':' + env.HANDSET_TWILIO_AUTH_TOKEN) } })
  if (!wire || wire.status !== 200) throw new Fault('provider_receipt_unavailable_case_still_due', 503)
  const port=row.kind==='port_pin',brand=row.kind==='brand_registration'
  const identityMatches=port?wire.body.port_in_request_sid===report.port_in_request_sid&&wire.body.phone_number_sid===(report.phone_number_sid??report.port_in_phone_number_sid):wire.body.sid===report.sid
  if(!identityMatches||wire.body.account_sid!==source.account_id||!brand&&(port?wire.body.phone_number:wire.body.tollfree_phone_number)!==source.e164)throw new Fault('provider_receipt_identity_mismatch',502)
  const state=text(port?wire.body.port_in_phone_number_status:wire.body.status,'providerState',80)
  const code=port?wire.body.rejection_reason_code:wire.body.error_code
  // Retain category codes, never free-form provider business facts or private PINs.
  const safe={observedAt:Date.now(),state,receiptId:port?wire.body.phone_number_sid:wire.body.sid,portDate:port&&typeof wire.body.port_date==='string'?wire.body.port_date:null,rejectionCode:code==null?null:integer(code,'rejectionCode',0,1000000),scope:brand?'account brand only; campaign and number eligibility unproved':'selected number',voiceReady:'unproved',smsReady:'unproved',reputation:'unknown'}
  await commit(env, actor, 'compliance.readback', row.id, 'completed', [fence, sourceFence(env, source), env.DB.prepare("UPDATE hnd_number_compliance SET status='follow_up',provider_state=?,readback=?,revision=revision+1,updated_at=? WHERE id=?").bind(state, JSON.stringify(safe), Date.now(), row.id), event(env, actor, row.id, 'readback', safe)])
 }
 return json({ case: await env.DB.prepare('SELECT * FROM hnd_number_compliance WHERE id=?').bind(row.id).first(), effectOccurred: false })
}
