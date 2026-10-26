import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { append, commit } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { escape as e, Fault, id, keys, text, type ObjectValue } from '../core'
import { sql } from '../delegation/store'
import type { FlowDefinition, FlowNode } from '../flows/definition'
import { evaluateFlow, explicitInstant } from '../flows/evaluation'
import { activeSourceById, sourceFence } from '../providers/sources'
import { attemptsPerStep, audioToken, interdigitSeconds, root } from './model'

interface Test { id: string; flow_version_id: string; source_id: string; instant: string; call_sid: string | null; expires_at: number }
interface Extension { extension: string; operator_id: string; directory_name: string; destination: string }

export async function requestTestCall(env: Bindings, actor: Session, v: ObjectValue) {
 keys(v, ['flowVersionId', 'sourceId', 'instant'])
 const flow = await sql(env, 'SELECT id FROM hnd_flow_versions WHERE id=?', text(v.flowVersionId, 'flowVersionId', 64)).first<{ id: string }>()
 if (!flow) throw new Fault('flow_version_missing', 404)
 const source = await activeSourceById(env, text(v.sourceId, 'sourceId', 64))
 if (!source) throw new Fault('source_inactive', 409)
 const target = id(), instant = explicitInstant(v.instant), now = Date.now()
 await commit(env, actor, 'prompt.test', target, 'completed', [sourceFence(env, source), sql(env, 'INSERT INTO hnd_prompt_tests(id,flow_version_id,source_id,instant,call_sid,created_by,created_at,expires_at) VALUES (?,?,?,?,NULL,?,?,?)', target, flow.id, source.id, instant, actor.operator.id, now, now + 900000)])
 return { id: target, providerPath: `${root}/tests/${target}`, instant, expiresAt: now + 900000, routing: 'Signed Gather door for one test call. It places no call and publishes nothing; the carrier route that reaches it is not configured by this server.' }
}

const nodeOf = (d: FlowDefinition, key: string) => { const n = d.nodes.find(x => x.id === key); if (!n) throw new Fault('flow_node_missing', 404); return n }
/** The first audible step reached from `from`: hours steps resolve against the test instant and its local calendar. */
function landing(d: FlowDefinition, instant: string, from: string, first: boolean): FlowNode {
 const menus = Object.fromEntries(d.nodes.filter(n => n.kind === 'menu').map(n => [n.id, n.next[0]]))
 const path = evaluateFlow({ ...d, entry: from, overrides: first ? d.overrides : [] }, { instant, choices: menus }).path
 return nodeOf(d, path.find(key => nodeOf(d, key).kind !== 'hours') ?? path[0])
}
const voice = (language: string) => language === 'es' ? 'language="es-MX"' : 'language="en-US"'

async function pinned(env: Bindings, node: FlowNode) {
 if (!node.prompt) return null
 const row = await sql(env, "SELECT id,language FROM hnd_prompt_versions WHERE id=? AND prompt_id=? AND state='approved'", node.prompt.versionId, node.prompt.promptId).first<{ id: string; language: string }>()
 if (!row) throw new Fault('pinned_prompt_unavailable', 409)
 return { ...row, url: `${env.AUTH_ORIGIN}${root}/audio/${row.id}/${await audioToken(env, row.id)}.wav` }
}
async function render(env: Bindings, test: Test, d: FlowDefinition, node: FlowNode, attempt: number, notice = '') {
 const prompt = await pinned(env, node), language = prompt?.language ?? node.language ?? 'en'
 const action = `${env.AUTH_ORIGIN}${root}/tests/${test.id}/node/${encodeURIComponent(node.id)}/digits/${attempt}`
 const speak = notice ? `<Say ${voice(language)}>${e(notice)}</Say>` : ''
 const body = `${speak}${prompt ? `<Play>${e(prompt.url)}</Play>` : ''}`
 // Digits are accepted for the whole greeting: the Gather wraps the Play, so an extension can be dialed halfway through it.
 const gather = `<Gather input="dtmf" finishOnKey="#" timeout="${interdigitSeconds}" actionOnEmptyResult="${node.kind === 'menu' ? 'true' : 'false'}" action="${e(action)}" method="POST">${body || '<Pause length="1"/>'}</Gather>`
 return { twiml: gather + (node.kind === 'menu' ? '' : '<Hangup/>'), event: { kind: 'node', detail: { kind: node.kind, queueId: node.queueId ?? null, prompt: node.prompt ?? null, attempt } } }
}
const dial = (ext: Pick<Extension, 'destination'>) => `<Dial timeout="20" answerOnBridge="true"><Number>${e(ext.destination)}</Number></Dial>`
async function directory(env: Bindings, digits: string) {
 return (await sql(env, "SELECT e.* FROM hnd_extensions e JOIN oa_operators o ON o.id=e.operator_id WHERE e.active=1 AND o.status='active' AND e.keypad LIKE ? ORDER BY e.directory_name LIMIT 9", digits + '%').all<Extension>()).results
}

export async function testCallResponse(env: Bindings, testId: string, rest: string, p: URLSearchParams): Promise<string> {
 const test = await sql(env, 'SELECT * FROM hnd_prompt_tests WHERE id=?', testId).first<Test>()
 if (!test) throw new Fault('not_found', 404)
 const source = await activeSourceById(env, test.source_id)
 if (!source) throw new Fault('source_inactive', 409)
 if (p.get('AccountSid') !== source.account_id) throw new Fault('test_call_account_mismatch', 403)
 if (test.expires_at <= Date.now()) throw new Fault('test_call_expired', 409)
 const sid = text(p.get('CallSid'), 'CallSid', 64)
 if (test.call_sid && test.call_sid !== sid) throw new Fault('test_call_identity_mismatch', 403)
 const d = JSON.parse((await sql(env, 'SELECT definition FROM hnd_flow_versions WHERE id=?', test.flow_version_id).first<{ definition: string }>())!.definition) as FlowDefinition
 const fences = [sourceFence(env, source), ...(test.call_sid ? [] : [sql(env, 'UPDATE hnd_prompt_tests SET call_sid=? WHERE id=? AND call_sid IS NULL', sid, test.id)])]
 const log = (node: string, kind: string, detail: unknown) => sql(env, 'INSERT INTO hnd_prompt_test_events VALUES (?,?,?,?,?,?)', id(), test.id, node, kind, JSON.stringify(detail), Date.now())
 const finish = async (node: string, event: { kind: string; detail: unknown }, twiml: string) => {
  await append(env, source.id, 'prompt.test', test.id, 'completed', [...fences, log(node, event.kind, event.detail)], null, sourcePolicy(source))
  return twiml
 }
 if (rest === '') {
  const node = landing(d, test.instant, d.entry, true), out = await render(env, test, d, node, 0)
  return finish(node.id, out.event, out.twiml)
 }
 const m = rest.match(/^\/node\/([^/]+)\/digits\/(\d)$/)
 if (m) {
  const node = nodeOf(d, decodeURIComponent(m[1])), attempt = Number(m[2]), digits = p.get('Digits') ?? '', lang = (await pinned(env, node))?.language ?? node.language ?? 'en'
  const again = async (notice: string, why: string) => {
   if (attempt + 1 >= attemptsPerStep) return finish(node.id, { kind: 'hangup', detail: { reason: why, digits } }, '<Hangup/>')
   const out = await render(env, test, d, node, attempt + 1, notice)
   return finish(node.id, { kind: why, detail: { digits, attempt } }, out.twiml)
  }
  if (!digits) return again('', 'no_input')
  // Documented disambiguation: exactly one digit is a menu key (1-9, 0 for the tenth); three to five digits are an extension;
  // '*' starts the directory by name. Two digits, or one digit on a step with no menu, never ring anyone.
  if (digits.startsWith('*')) {
   const letters = digits.slice(1)
   if (!/^\d{3,9}$/.test(letters)) {
    const action = `${env.AUTH_ORIGIN}${root}/tests/${test.id}/node/${encodeURIComponent(node.id)}/directory`
    return finish(node.id, { kind: 'directory_prompt', detail: {} }, `<Gather input="dtmf" finishOnKey="#" timeout="${interdigitSeconds}" actionOnEmptyResult="true" action="${e(action)}" method="POST"><Say ${voice(lang)}>Enter the first letters of the last name, then press pound.</Say></Gather>`)
   }
   return directoryResult(env, test, d, node, lang, letters, finish, again)
  }
  if (/^\d$/.test(digits) && node.kind === 'menu') {
   const target = node.next[digits === '0' ? 9 : Number(digits) - 1]
   if (!target) return again('That option is not available.', 'invalid_menu_key')
   const next = landing(d, test.instant, target, false), out = await render(env, test, d, next, 0)
   return finish(next.id, { kind: 'menu_choice', detail: { from: node.id, key: digits, to: target, ...out.event.detail } }, out.twiml)
  }
  if (/^\d{3,5}$/.test(digits)) {
   const ext = await sql(env, "SELECT e.* FROM hnd_extensions e JOIN oa_operators o ON o.id=e.operator_id WHERE e.extension=? AND e.active=1 AND o.status='active'", digits).first<Extension>()
   if (!ext) return again('That extension was not found.', 'unknown_extension')
   return finish(node.id, { kind: 'extension_dial', detail: { extension: ext.extension, operatorId: ext.operator_id, destination: ext.destination, midGreeting: !!node.prompt } }, dial(ext))
  }
  return again('That entry was not recognized.', 'invalid_entry')
 }
 const dir = rest.match(/^\/node\/([^/]+)\/directory$/)
 if (dir) {
  const node = nodeOf(d, decodeURIComponent(dir[1])), lang = (await pinned(env, node))?.language ?? node.language ?? 'en', digits = p.get('Digits') ?? ''
  const again = async (notice: string, why: string) => { const out = await render(env, test, d, node, 0, notice); return finish(node.id, { kind: why, detail: { digits } }, out.twiml) }
  if (!/^\d{3,9}$/.test(digits)) return again('That name was not recognized.', 'invalid_directory_entry')
  return directoryResult(env, test, d, node, lang, digits, finish, again)
 }
 const pick = rest.match(/^\/node\/([^/]+)\/directory-pick\/(\d{3,9})$/)
 if (pick) {
  const node = nodeOf(d, decodeURIComponent(pick[1])), found = await directory(env, pick[2]), choice = found[Number(p.get('Digits')) - 1]
  if (!choice) { const out = await render(env, test, d, node, 0, 'That choice is not available.'); return finish(node.id, { kind: 'invalid_directory_choice', detail: {} }, out.twiml) }
  return finish(node.id, { kind: 'directory_dial', detail: { extension: choice.extension, operatorId: choice.operator_id, destination: choice.destination, disambiguated: true } }, dial(choice))
 }
 throw new Fault('not_found', 404)
}
async function directoryResult(env: Bindings, test: Test, d: FlowDefinition, node: FlowNode, lang: string, digits: string, finish: (n: string, ev: { kind: string; detail: unknown }, t: string) => Promise<string>, again: (notice: string, why: string) => Promise<string>) {
 const found = await directory(env, digits)
 if (!found.length) return again('No one matches those letters.', 'directory_no_match')
 if (found.length === 1) return finish(node.id, { kind: 'directory_dial', detail: { extension: found[0].extension, operatorId: found[0].operator_id, destination: found[0].destination, keypad: digits } }, `<Say ${voice(lang)}>${e('Connecting you to ' + found[0].directory_name + '.')}</Say>${dial(found[0])}`)
 const action = `${env.AUTH_ORIGIN}${root}/tests/${test.id}/node/${encodeURIComponent(node.id)}/directory-pick/${digits}`
 const list = found.map((x, i) => `${x.directory_name}, press ${i + 1}.`).join(' ')
 return finish(node.id, { kind: 'directory_choice', detail: { keypad: digits, matches: found.map(x => x.extension) } }, `<Gather input="dtmf" numDigits="1" timeout="${interdigitSeconds}" actionOnEmptyResult="true" action="${e(action)}" method="POST"><Say ${voice(lang)}>${e(list)}</Say></Gather>`)
}
