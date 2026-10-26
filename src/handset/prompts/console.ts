import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, consolePage, escape as e, owner, type ObjectValue } from '../core'
import { sql } from '../delegation/store'
import { promptDoor, purposes } from './doors'
import { variants } from './model'
import { columns, joined } from './store'

type Prompt = { id: string; name: string; purpose: string; shared: number }
type Version = { id: string; prompt_id: string; version: number; source: string; language: string; variant: string; schedule: string; script: string | null; audio_sha256: string; duration_ms: number; state: string; author_name: string; original_format: string }
const label = (value: string) => value.replaceAll('_', ' ')
const select = (form: string, name: string, text: string, options: [string, string][]) => `<label for="${e(form)}-${e(name)}">${e(text)}</label><select id="${e(form)}-${e(name)}" name="${e(name)}">${options.map(([v, t]) => `<option value="${e(v)}">${e(t)}</option>`).join('')}</select>`

function versionRow(v: Version) {
 const s = JSON.parse(v.schedule) as { effectiveFrom?: string; effectiveUntil?: string }
 const when = s.effectiveFrom || s.effectiveUntil ? `${s.effectiveFrom ?? 'any time'} to ${s.effectiveUntil ?? 'open'}` : 'no dated window'
 const act = (path: string, text: string, extra = '') => `<form method="post" action="/app/prompts/versions/${e(v.id)}/${path}"><input type="hidden" name="audioSha256" value="${e(v.audio_sha256)}">${extra}<button type="submit">${text}</button></form>`
 return `<li class="hnd-prompt-version"><h3>Version ${v.version} · ${e(label(v.state))}</h3><p>${e(label(v.source))} · ${v.language === 'es' ? 'Spanish' : 'English'} · ${e(label(v.variant))} · ${e(when)} · ${(v.duration_ms / 1000).toFixed(1)} seconds · carrier format · by ${e(v.author_name)}</p>${v.script ? `<p>Script: ${e(v.script)}</p>` : ''}<audio controls preload="none" src="/api/handset/prompts/versions/${e(v.id)}/audio" aria-label="Preview version ${v.version}"></audio>${v.state === 'draft' ? act('preview', 'Mark previewed') : ''}${v.state === 'previewed' ? act('approve', 'Approve this exact version', '<input type="hidden" name="confirm" value="approve this exact prompt version">') : ''}${v.state === 'approved' ? '<p>Approved. Flows pin this exact version; later versions never change a published flow.</p>' : ''}</li>`
}
async function snapshot(env: Bindings) {
 const prompts = (await sql(env, 'SELECT id,name,purpose,shared FROM hnd_prompts ORDER BY created_at DESC LIMIT 100').all<Prompt>()).results
 const versions = (await sql(env, `SELECT ${columns} ${joined} ORDER BY v.prompt_id,v.version DESC LIMIT 500`).all<Version>()).results
 const people = (await sql(env, "SELECT id,display_name FROM oa_operators WHERE status='active' ORDER BY display_name LIMIT 100").all<{ id: string; display_name: string }>()).results
 const extensions = (await sql(env, 'SELECT extension,directory_name,destination,active FROM hnd_extensions ORDER BY extension LIMIT 200').all<{ extension: string; directory_name: string; destination: string; active: number }>()).results
 const sources = (await sql(env, "SELECT s.id,json_extract(n.data,'$.e164') AS e164 FROM hnd_sources s JOIN hnd_records n ON n.id=s.number_id WHERE s.revoked_at IS NULL ORDER BY s.created_at LIMIT 20").all<{ id: string; e164: string }>()).results
 return { prompts, versions, people, extensions, sources }
}
async function view(env: Bindings, notice = '', status = 200, extra = '') {
 const { prompts, versions, people, extensions, sources } = await snapshot(env)
 const response = await consolePage('Greetings and prompts', `<link rel="stylesheet" href="/handset-flows.css"><p role="status">Prompt authoring is preparatory. Previews and signed-edge tests play nothing to customers and publish nothing. Prompt versions are pinned to flow versions; changing a shared prompt never alters a published flow.</p>${notice ? `<p role="alert">${e(notice)}</p>` : ''}${extra}
<section class="hnd-panel"><h2>New prompt</h2><form method="post" action="/app/prompts"><label>Name<input name="name" required maxlength="120"></label>${select('new', 'purpose', 'Use', purposes.map(p => [p, label(p)]))}<label><input type="checkbox" name="shared" value="yes"> Shared by more than one flow</label><button type="submit">Create prompt</button></form></section>
<section class="hnd-panel"><h2>Add a version</h2><form method="post" action="/app/prompts/versions" data-prompt-author>${select('author', 'promptId', 'Prompt', prompts.map(p => [p.id, p.name]))}${select('author', 'source', 'Source', [['upload', 'Audio file upload (WAV)'], ['browser_recording', 'Browser microphone'], ['tts', 'Text to speech']])}${select('author', 'language', 'Language', [['en', 'English'], ['es', 'Spanish']])}${select('author', 'variant', 'Schedule variant', variants.map(v => [v, label(v)]))}<label>Effective from<input type="date" name="effectiveFrom"></label><label>Effective until<input type="date" name="effectiveUntil"></label>
<label data-source="upload">Audio file<input type="file" accept="audio/wav,.wav" data-audio-file></label><div data-source="browser_recording"><button type="button" data-record-start>Start recording</button> <button type="button" data-record-stop disabled>Stop recording</button><audio controls hidden data-record-preview aria-label="Recording preview"></audio></div><label data-source="tts">Greeting text<textarea name="script" maxlength="1000" rows="3"></textarea></label><input type="hidden" name="audioBase64" data-audio-field><p role="status" data-audio-status></p><button type="submit">Add version</button></form><script src="/handset-prompts.js"></script></section>
<section class="hnd-panel"><h2>Record by phone</h2><p>The callback goes only to your own registered extension number and needs the one-time code shown once here.</p><form method="post" action="/app/prompts/phone-recordings">${select('phone', 'promptId', 'Prompt', prompts.map(p => [p.id, p.name]))}${select('phone', 'sourceId', 'Business number', sources.map(s => [s.id, s.e164]))}${select('phone', 'language', 'Language', [['en', 'English'], ['es', 'Spanish']])}${select('phone', 'variant', 'Schedule variant', variants.map(v => [v, label(v)]))}<label>Your registered number<input name="destination" required placeholder="+15125550100"></label><button type="submit">Request recording call</button></form></section>
<section class="hnd-panel"><h2>Dial by extension and name</h2><p>Callers press one key for a menu option, dial three to five digits for an extension, or press star then the first letters of a last name. The caller has three seconds between digits, and pound ends entry early.</p><ul>${extensions.map(x => `<li>${e(x.extension)} · ${e(x.directory_name)} · ${e(x.destination)}${x.active ? '' : ' · inactive'}</li>`).join('') || '<li>No extensions yet.</li>'}</ul><form method="post" action="/app/prompts/extensions">${select('extension', 'operatorId', 'Person', people.map(p => [p.id, p.display_name]))}<label>Extension<input name="extension" required pattern="[0-9]{3,5}" inputmode="numeric"></label><label>Directory name<input name="directoryName" required maxlength="80"></label><label>Rings this number<input name="destination" required placeholder="+15125550100"></label><button type="submit">Save extension</button></form></section>
<h2>Prompts and versions</h2>${prompts.map(p => `<section class="hnd-panel"><h3>${e(p.name)}</h3><p>${e(label(p.purpose))}${p.shared ? ' · shared' : ''}</p><ul>${versions.filter(v => v.prompt_id === p.id).map(versionRow).join('') || '<li>No versions yet.</li>'}</ul></section>`).join('') || '<p>No prompts yet.</p>'}`, status)
 // The microphone recorder is this origin's own script; previews play from this origin or the in-page recording.
 response.headers.set('content-security-policy', response.headers.get('content-security-policy')! + "; script-src 'self'; media-src 'self' blob:")
 return response
}
export async function promptConsole(request: Request, env: Bindings, actor: Session, v?: ObjectValue): Promise<Response> {
 owner(actor)
 const url = new URL(request.url), path = url.pathname
 if (url.search) throw new Fault('unexpected_prompt_query')
 if (request.method === 'GET') { if (path !== '/app/prompts') throw new Fault('not_found', 404); return view(env) }
 if (request.method !== 'POST' || !v) throw new Fault('method_not_allowed', 405)
 const api = (target: string, body: ObjectValue) => promptDoor(new Request(new URL('/api/handset/prompts' + target, url), { method: 'POST' }), env, actor, body)
 try {
  let result: Response
  if (path === '/app/prompts') result = await api('', { name: v.name, purpose: v.purpose, shared: v.shared === 'yes' })
  else if (path === '/app/prompts/versions') {
   const schedule = { ...(v.effectiveFrom ? { effectiveFrom: v.effectiveFrom } : {}), ...(v.effectiveUntil ? { effectiveUntil: v.effectiveUntil } : {}) }
   result = await api(`/${String(v.promptId)}/versions`, { source: v.source, language: v.language, variant: v.variant, schedule, ...(v.source === 'tts' ? { script: v.script } : { audioBase64: v.audioBase64 }) })
  } else if (path === '/app/prompts/phone-recordings') {
   result = await api(`/${String(v.promptId)}/phone-recordings`, { sourceId: v.sourceId, language: v.language, variant: v.variant, destination: v.destination })
   const made = await result.json() as { pin: string; providerPath: string }
   return view(env, '', 200, `<p role="status">Recording request created. One-time code <strong>${e(made.pin)}</strong>. It is not shown again. The carrier answers ${e(made.providerPath)}.</p>`)
  } else if (path === '/app/prompts/extensions') result = await api('/extensions', { ...v, active: true })
  else {
   const m = path.match(/^\/app\/prompts\/versions\/([0-9a-f-]{36})\/(preview|approve)$/)
   if (!m) throw new Fault('not_found', 404)
   result = await api(`/versions/${m[1]}/${m[2]}`, v)
  }
  void result
  return new Response(null, { status: 303, headers: { location: '/app/prompts' } })
 } catch (error) {
  if (error instanceof Fault) return view(env, error.code.replaceAll('_', ' '), error.status)
  throw error
 }
}
