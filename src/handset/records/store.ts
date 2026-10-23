import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, id, keys, text, timestamp, integer, choice, object, type ObjectValue } from '../core'
import { recordInput, type RecordRow } from './model'
import type { CaseAuthority } from './access'

export interface CaseRow { id: string; title: string; owner_id: string; due_at: number|null; promise: string; status: string; handled: number; unread: number; version: number; actor_id: string; updated_at: number; close_reason: string }
export interface RecordLink {record_id:string;target_id:string;relation:string}
export async function getCase(db: D1Database, caseId: string) {
 const current = await db.prepare('SELECT * FROM hnd_cases WHERE id=?').bind(caseId).first<CaseRow>()
 if (!current) throw new Fault('case_not_found', 404)
 const [history, records] = await Promise.all([
  db.prepare('SELECT * FROM hnd_case_history WHERE case_id=? ORDER BY version').bind(caseId).all(),
  db.prepare('SELECT r.*,s.source_kind AS verified_source FROM hnd_records r LEFT JOIN hnd_record_sources s ON s.record_id=r.id WHERE r.case_id=? ORDER BY r.occurred_at,r.received_at,r.id').bind(caseId).all<RecordRow>(),
 ])
 return { current, history: history.results, records: records.results.map(sourceRow) }
}
export function caseFilter(value: ObjectValue) {
 keys(value, ['q','status','ownerId','due','unread','handled'])
 const query: Record<string,string> = {}
 for (const [key, raw] of Object.entries(value)) if (raw !== '') query[key] = text(raw, key)
 if (query.status) choice(query.status, ['open','closed'], 'status')
 if (query.due) choice(query.due, ['overdue','scheduled'], 'due')
 for (const key of ['unread','handled']) if (query[key]) choice(query[key], ['0','1'], key)
 return query
}
export async function listCases(db: D1Database, query: Record<string,string>, visible?:string[]) {
 const clauses: string[] = [], values: (string|number)[] = []
 if(visible){clauses.push('id IN (SELECT value FROM json_each(?))');values.push(JSON.stringify(visible))}
 if (query.q) { clauses.push(`(instr(lower(title),lower(?))>0 OR instr(lower(promise),lower(?))>0 OR EXISTS(SELECT 1 FROM hnd_records r WHERE r.case_id=hnd_cases.id AND instr(lower(r.data),lower(?))>0))`); values.push(query.q,query.q,query.q) }
 for (const [name, column] of [['status','status'],['ownerId','owner_id'],['unread','unread'],['handled','handled']]) if (query[name]) { clauses.push(`${column}=?`); values.push(query[name]) }
 if (query.due) { clauses.push(query.due === 'overdue' ? 'due_at<?' : 'due_at>=?'); values.push(Date.now()) }
 return (await db.prepare(`SELECT * FROM hnd_cases ${clauses.length ? 'WHERE '+clauses.join(' AND ') : ''} ORDER BY updated_at DESC,id LIMIT 201`).bind(...values).all<CaseRow>()).results
}
function caseValues(value: ObjectValue, actor: Session) {
 keys(value, ['title','ownerId','dueAt','promise','status','handled','unread','version','closeReason'])
 const promise = text(value.promise ?? '', 'promise', 2000, true)
 const dueAt = value.dueAt === null || value.dueAt === '' || value.dueAt === undefined ? null : timestamp(value.dueAt, 'dueAt')
 if (promise && dueAt === null) throw new Fault('promise_needs_due_date')
 const status = choice(value.status ?? 'open', ['open','closed'], 'status')
 const closeReason = text(value.closeReason ?? '', 'closeReason', 1000, true)
 if (status === 'closed' && !closeReason) throw new Fault('close_reason_required')
 return { title: text(value.title, 'title'), ownerId: text(value.ownerId ?? actor.operator.id,'ownerId'), dueAt, promise, status, handled: integer(value.handled ?? 0,'handled',0,1), unread: integer(value.unread ?? 1,'unread',0,1), closeReason }
}
export async function writeCase(env: Bindings, actor: Session, value: ObjectValue, caseId?: string, authority?:CaseAuthority) {
 const db = env.DB, v = caseValues(value,actor), now = Date.now(), target = caseId ?? id()
 const activeOwner = db.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND status='active'`).bind(v.ownerId)
 const statements = [...(authority?.fences??[]),activeOwner]
 if (caseId) {
  const expected = integer(value.version,'version',1)
  const { current } = await getCase(db,caseId)
  if (current.version !== expected) throw new Fault('version_conflict',409, await getCase(db,caseId))
  statements.push(db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_cases WHERE id=? AND version=?').bind(caseId,expected))
  statements.push(db.prepare(`UPDATE hnd_cases SET title=?,owner_id=?,due_at=?,promise=?,status=?,handled=?,unread=?,version=version+1,actor_id=?,updated_at=?,close_reason=? WHERE id=? AND version=?`).bind(v.title,v.ownerId,v.dueAt,v.promise,v.status,v.handled,v.unread,actor.operator.id,now,v.closeReason,caseId,expected))
 } else {
  statements.push(db.prepare('INSERT INTO hnd_cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(target,v.title,v.ownerId,v.dueAt,v.promise,v.status,v.handled,v.unread,1,actor.operator.id,now,v.closeReason))
 }
 try { await commit(env,actor,caseId ? 'case.correct' : 'case.create',target,'completed',statements,!authority,authority?.applied) }
 catch (error) {
  if (error instanceof Fault && error.code === 'state_changed' && caseId) throw new Fault('version_conflict',409,await getCase(db,caseId))
  throw error
 }
 return getCase(db,target)
}
export async function addRecord(env: Bindings, actor: Session, value: ObjectValue, authority?:CaseAuthority) {
 const db = env.DB, v = recordInput(value), recordId = id(), now = Date.now()
 const existing = await db.prepare('SELECT * FROM hnd_records WHERE kind=? AND source=? AND source_id=?').bind(v.kind,'native',v.sourceId).first<RecordRow>()
 if (existing) {
  const links = (await db.prepare('SELECT target_id AS targetId,relation FROM hnd_record_links WHERE record_id=? ORDER BY target_id,relation').bind(existing.id).all()).results
  const order = (links: unknown[]) => JSON.stringify([...links].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))
  if (existing.data !== JSON.stringify(v.data) || existing.case_id !== v.caseId || existing.parent_id !== v.parentId || existing.supersedes_id !== v.supersedesId || existing.occurred_at !== v.occurredAt || order(links) !== order(v.links)) throw new Fault('source_conflict',409,{ current: existing })
  return { record: existing, replay: true }
 }
 if (v.caseId) await getCase(db,v.caseId)
 if(v.data.transferFrom && v.data.transferFrom !== v.parentId)throw new Fault('transfer_source_mismatch')
 if(v.data.mention && !v.links.some(link=>link.targetId===v.data.mention&&link.relation==='mentions'))throw new Fault('mention_link_required')
 const referenceIds = [...new Set([v.parentId,v.supersedesId,...v.links.map(link=>link.targetId)].filter((x):x is string=>Boolean(x)))]
 for (const referenceId of referenceIds) {
  const referenced = await db.prepare('SELECT * FROM hnd_records WHERE id=?').bind(referenceId).first<RecordRow>()
  if (!referenced) throw new Fault('linked_record_not_found')
  if (referenced.case_id && referenced.case_id !== v.caseId) throw new Fault('cross_case_link_refused')
  const relationKinds:Record<string,string[]>={company:['company'],location:['location'],number:['number'],person:['person'],endpoint:['endpoint'],flow:['flow_version'],session:['call_session'],leg:['call_leg'],conversation:['conversation'],media:['media','recording'],consent:['consent'],attempt:['provider_attempt'],usage:['usage'],mentions:['person']}
  for(const link of v.links.filter(link=>link.targetId===referenceId))if(!relationKinds[link.relation]?.includes(referenced.kind))throw new Fault('link_kind_mismatch')
  if (referenceId === v.supersedesId && (referenced.kind !== v.kind || referenced.case_id !== v.caseId)) throw new Fault('correction_kind_mismatch')
  if (referenceId === v.parentId && v.kind === 'call_leg' && !['call_session','call_leg'].includes(referenced.kind)) throw new Fault('leg_parent_required')
 }
 if (v.kind === 'call_leg' && !v.parentId) throw new Fault('leg_parent_required')
 const record: RecordRow = { id: recordId, kind:v.kind,source:'native',source_id:v.sourceId,occurred_at:v.occurredAt,received_at:now,case_id:v.caseId,parent_id:v.parentId,supersedes_id:v.supersedesId,data:JSON.stringify(v.data),actor_id:actor.operator.id }
 try {
  await commit(env,actor,'record.create',recordId,'completed',[
   ...(authority?.fences??[]),
   db.prepare('INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(...Object.values(record)),
   ...v.links.map(link=>db.prepare('INSERT INTO hnd_record_links VALUES (?,?,?)').bind(recordId,link.targetId,link.relation)),
  ],!authority,authority?.applied)
 } catch (error) {
  if (String(error).includes('UNIQUE constraint failed: hnd_records.kind'))return addRecord(env,actor,value,authority)
  if (/UNIQUE constraint failed: hnd_records/.test(String(error))) throw new Fault('source_or_correction_conflict',409)
  throw error
 }
 return { record, replay: false }
}
export async function getRecord(db: D1Database, recordId: string) {
 const record = await db.prepare('SELECT r.*,s.source_kind AS verified_source FROM hnd_records r LEFT JOIN hnd_record_sources s ON s.record_id=r.id WHERE r.id=?').bind(recordId).first<RecordRow>()
 if (!record) throw new Fault('record_not_found',404)
 const links = (await db.prepare('SELECT * FROM hnd_record_links WHERE record_id=? OR target_id=?').bind(recordId,recordId).all<RecordLink>()).results
 const related=(await db.prepare('SELECT r.*,s.source_kind AS verified_source FROM hnd_records r LEFT JOIN hnd_record_sources s ON s.record_id=r.id WHERE r.parent_id=? ORDER BY r.occurred_at,r.received_at,r.id').bind(recordId).all<RecordRow>()).results.map(sourceRow)
 return { record:sourceRow(record), links, related }
}
export async function saveFilter(env: Bindings, actor: Session, value: ObjectValue, authority?:CaseAuthority) {
 keys(value,['name','query'])
 const filterId = id(), name = text(value.name,'name',80), query = caseFilter(object(value.query))
 try { await commit(env,actor,'filter.create',filterId,'completed',[
  ...(authority?.fences??[]),env.DB.prepare('INSERT INTO hnd_filters VALUES (?,?,?,?,?)').bind(filterId,actor.operator.id,name,JSON.stringify(query),Date.now()),
 ],!authority,authority?.applied) } catch(error) { if (String(error).includes('UNIQUE constraint')) throw new Fault('filter_name_exists',409); throw error }
 return { id:filterId,name,query }
}

function sourceRow(row:RecordRow & {verified_source?:string|null}){const {verified_source,...record}=row;return {...record,source:verified_source??record.source}}
