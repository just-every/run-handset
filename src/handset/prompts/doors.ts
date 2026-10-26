import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, choice, id, json, keys, owner, text, type ObjectValue } from '../core'
import { guard, sql } from '../delegation/store'
import type { FlowDefinition } from '../flows/definition'
import { fromBase64, normalizeAudio, storedAudio } from './audio'
import { requestPhoneRecording } from './phone'
import { requestTestCall } from './test-calls'
import { synthesize } from './tts'
import { keypad, variants, type Language } from './model'
import { columns, joined, version, versionInsert, type NewVersion } from './store'

export const purposes = ['main_attendant', 'menu', 'queue', 'holiday', 'after_hours'] as const
const sources = ['upload', 'browser_recording', 'tts'] as const
const languages = ['en', 'es'] as const
const date = (value: unknown, name: string) => {
 const v = text(value, name, 10)
 if (!/^\d{4}-\d\d-\d\d$/.test(v) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) throw new Fault('invalid_' + name)
 return v
}
export function schedule(raw: unknown) {
 const v = (raw ?? {}) as ObjectValue
 if (typeof v !== 'object' || Array.isArray(v)) throw new Fault('invalid_schedule')
 keys(v, ['effectiveFrom', 'effectiveUntil', 'note'])
 const out = { ...(v.effectiveFrom ? { effectiveFrom: date(v.effectiveFrom, 'effectiveFrom') } : {}), ...(v.effectiveUntil ? { effectiveUntil: date(v.effectiveUntil, 'effectiveUntil') } : {}), ...(v.note ? { note: text(v.note, 'note', 300) } : {}) } as { effectiveFrom?: string; effectiveUntil?: string; note?: string }
 if (out.effectiveFrom && out.effectiveUntil && out.effectiveFrom > out.effectiveUntil) throw new Fault('invalid_schedule')
 return out
}
export async function addVersion(env: Bindings, actor: Session, promptId: string, v: NewVersion) {
 const { target, statements } = await versionInsert(env, actor.operator.id, promptId, v)
 await commit(env, actor, 'prompt.create', target, 'completed', statements)
 return version(env, target)
}
async function author(env: Bindings, actor: Session, promptId: string, v: ObjectValue) {
 keys(v, ['source', 'language', 'variant', 'schedule', 'audioBase64', 'script'])
 const source = choice(v.source, sources, 'source'), language = choice(v.language, languages, 'language'), variant = choice(v.variant, variants, 'variant')
 const prompt = await sql(env, 'SELECT id FROM hnd_prompts WHERE id=?', promptId).first()
 if (!prompt) throw new Fault('prompt_missing', 404)
 let raw: Uint8Array, script: string | undefined
 if (source === 'tts') {
  if (v.audioBase64 !== undefined) throw new Fault('tts_takes_script_only')
  script = text(v.script, 'script', 1000)
  raw = await synthesize(env, language, script)
 } else {
  if (v.script !== undefined) throw new Fault('audio_source_takes_no_script')
  raw = fromBase64(v.audioBase64)
 }
 const normalized = normalizeAudio(raw)
 const row = await addVersion(env, actor, promptId, { source, language, variant, schedule: schedule(v.schedule), script, audio: normalized.wav, original: source === 'tts' ? 'tts-' + normalized.original : normalized.original, durationMs: normalized.durationMs })
 return row
}
async function extensionWrite(env: Bindings, actor: Session, v: ObjectValue) {
 keys(v, ['extension', 'operatorId', 'directoryName', 'destination', 'active'])
 const extension = text(v.extension, 'extension', 5), name = text(v.directoryName, 'directoryName', 80), destination = text(v.destination, 'destination', 16), person = text(v.operatorId, 'operatorId', 64)
 if (!/^\d{3,5}$/.test(extension) || !/^\+[1-9]\d{7,14}$/.test(destination) || !keypad(name.split(/\s+/).at(-1)!)) throw new Fault('invalid_extension')
 const active = v.active === false ? 0 : 1, operator = await sql(env, "SELECT version FROM oa_operators WHERE id=? AND status='active'", person).first<{ version: number }>()
 if (!operator) throw new Fault('active_person_required', 409)
 const target = id()
 await commit(env, actor, 'extension.write', target, 'completed', [
  guard(env, "SELECT count(*) FROM oa_operators WHERE id=? AND status='active'", person),
  sql(env, 'INSERT INTO hnd_extensions VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(extension) DO UPDATE SET operator_id=excluded.operator_id,directory_name=excluded.directory_name,keypad=excluded.keypad,destination=excluded.destination,active=excluded.active', extension, person, name, keypad(name.split(/\s+/).at(-1)!), destination, active, actor.operator.id, Date.now())])
 return { extension, operatorId: person, directoryName: name, active: !!active, ringsDestination: 'registered by the named owner; HND-078 personal answering rules are not applied' }
}
export async function promptDoor(request: Request, env: Bindings, actor: Session, value?: ObjectValue): Promise<Response> {
 owner(actor)
 const url = new URL(request.url), base = '/api/handset/prompts', path = url.pathname
 if (url.search) throw new Fault('unexpected_prompt_query')
 if (path === base && request.method === 'GET') {
  const prompts = (await sql(env, 'SELECT p.*,o.display_name AS author_name FROM hnd_prompts p JOIN oa_operators o ON o.id=p.created_by ORDER BY p.created_at DESC LIMIT 200').all()).results
  const versions = (await sql(env, `SELECT ${columns} ${joined} ORDER BY v.created_at DESC LIMIT 500`).all()).results
  const extensions = (await sql(env, 'SELECT extension,operator_id,directory_name,destination,active FROM hnd_extensions ORDER BY extension LIMIT 500').all()).results
  const recordings = (await sql(env, 'SELECT id,prompt_id,source_id,language,variant,author_id,destination,state,version_id,expires_at,created_at FROM hnd_prompt_recordings ORDER BY created_at DESC LIMIT 100').all()).results
  const tests = (await sql(env, 'SELECT t.id,t.flow_version_id,t.instant,t.call_sid,t.expires_at,(SELECT json_group_array(json_object(\'node\',node_id,\'kind\',kind,\'detail\',json(detail))) FROM hnd_prompt_test_events e WHERE e.test_id=t.id) AS events FROM hnd_prompt_tests t ORDER BY t.created_at DESC LIMIT 100').all()).results
  await commit(env, actor, 'prompt.read', 'installation', 'completed')
  return json({ prompts, versions, extensions, recordings, tests, qualification: 'native authoring and signed-edge fakes; no audible carrier test call or live record-by-phone call has been placed' })
 }
 if (request.method !== 'POST' || !value) {
  const audio = path.match(/^\/api\/handset\/prompts\/versions\/([0-9a-f-]{36})\/audio$/)
  if (audio && request.method === 'GET') {
   const row = await sql(env, 'SELECT audio FROM hnd_prompt_versions WHERE id=?', audio[1]).first<{ audio: string }>()
   if (!row) throw new Fault('prompt_version_missing', 404)
   const bytes = storedAudio(row.audio)
   await commit(env, actor, 'prompt.read', audio[1], 'completed')
   return new Response(bytes, { headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } })
  }
  const pins = path.match(/^\/api\/handset\/prompts\/pins\/([0-9a-f-]{36})$/)
  if (pins && request.method === 'GET') {
   const flow = await sql(env, 'SELECT id,flow_id,version,state,definition FROM hnd_flow_versions WHERE id=?', pins[1]).first<{ id: string; flow_id: string; version: number; state: string; definition: string }>()
   if (!flow) throw new Fault('flow_version_missing', 404)
   const d = JSON.parse(flow.definition) as FlowDefinition, found = []
   for (const n of d.nodes) if (n.prompt) found.push({ nodeId: n.id, ...await version(env, n.prompt.versionId) })
   await commit(env, actor, 'prompt.read', flow.id, 'completed')
   return json({ flowVersionId: flow.id, flowVersion: flow.version, flowState: flow.state, pins: found })
  }
  throw new Fault('method_not_allowed', 405)
 }
 if (path === base) {
  keys(value, ['name', 'purpose', 'shared'])
  const name = text(value.name, 'name', 120), purpose = choice(value.purpose, purposes, 'purpose'), shared = value.shared === true ? 1 : 0, target = id()
  await commit(env, actor, 'prompt.create', target, 'completed', [sql(env, 'INSERT INTO hnd_prompts VALUES (?,?,?,?,?,?)', target, name, purpose, shared, actor.operator.id, Date.now())])
  return json({ id: target, name, purpose, shared: !!shared }, 201)
 }
 if (path === base + '/extensions') return json(await extensionWrite(env, actor, value), 201)
 if (path === base + '/test-calls') return json(await requestTestCall(env, actor, value), 201)
 const authoring = path.match(/^\/api\/handset\/prompts\/([0-9a-f-]{36})\/(versions|phone-recordings)$/)
 if (authoring) return json(authoring[2] === 'versions' ? await author(env, actor, authoring[1], value) : await requestPhoneRecording(env, actor, authoring[1], value), 201)
 const act = path.match(/^\/api\/handset\/prompts\/versions\/([0-9a-f-]{36})\/(preview|approve)$/)
 if (!act) throw new Fault('not_found', 404)
 const row = await version(env, act[1])
 if (act[2] === 'preview') {
  keys(value, ['audioSha256'])
  if (value.audioSha256 !== row.audio_sha256) throw new Fault('exact_audio_required', 409)
  if (row.state === 'approved') return json(row)
  await commit(env, actor, 'prompt.preview', act[1], 'completed', [guard(env, "SELECT count(*) FROM hnd_prompt_versions WHERE id=? AND audio_sha256=? AND state IN ('draft','previewed')", act[1], row.audio_sha256), sql(env, "UPDATE hnd_prompt_versions SET state='previewed',previewed_by=?,previewed_at=? WHERE id=? AND state IN ('draft','previewed')", actor.operator.id, Date.now(), act[1])])
  return json(await version(env, act[1]))
 }
 keys(value, ['audioSha256', 'confirm'])
 if (value.confirm !== 'approve this exact prompt version') throw new Fault('exact_prompt_approval_required', 403)
 if (value.audioSha256 !== row.audio_sha256) throw new Fault('exact_audio_required', 409)
 if (row.state !== 'previewed') throw new Fault(row.state === 'approved' ? 'prompt_already_approved' : 'prompt_preview_required', 409)
 await commit(env, actor, 'prompt.approve', act[1], 'completed', [guard(env, "SELECT count(*) FROM hnd_prompt_versions WHERE id=? AND state='previewed' AND audio_sha256=?", act[1], row.audio_sha256), sql(env, "UPDATE hnd_prompt_versions SET state='approved',approved_by=?,approved_at=? WHERE id=? AND state='previewed'", actor.operator.id, Date.now(), act[1])])
 return json({ ...await version(env, act[1]), affectsPublishedFlows: false })
}
