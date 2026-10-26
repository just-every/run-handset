import type { Bindings } from '../../auth.server'
import { Fault, id } from '../core'
import { guard, sql } from '../delegation/store'
import { sha256, toBase64 } from './audio'
import type { Language, Variant } from './model'

export const columns = 'v.id,v.prompt_id,v.version,v.source,v.language,v.variant,v.schedule,v.script,v.original_format,v.audio_sha256,v.duration_ms,v.state,v.author_id,a.display_name AS author_name,v.created_at,v.previewed_by,v.previewed_at,v.approved_by,v.approved_at'
export const joined = `FROM hnd_prompt_versions v JOIN oa_operators a ON a.id=v.author_id`
export async function version(env: Bindings, target: string) {
 const row = await sql(env, `SELECT ${columns},p.shared,p.name,p.purpose ${joined} JOIN hnd_prompts p ON p.id=v.prompt_id WHERE v.id=?`, target).first<Record<string, unknown> & { state: string; audio_sha256: string }>()
 if (!row) throw new Fault('prompt_version_missing', 404)
 return row
}
export type NewVersion = { source: string; language: Language; variant: Variant; schedule: unknown; script?: string; audio: Uint8Array; original: string; durationMs: number }
/** Statements that insert the next version of a prompt; the caller commits them with its own audit event. */
export async function versionInsert(env: Bindings, authorId: string, promptId: string, v: NewVersion) {
 const target = id(), hash = await sha256(v.audio)
 return { target, statements: [
  guard(env, 'SELECT count(*) FROM hnd_prompts WHERE id=?', promptId),
  sql(env, 'INSERT INTO hnd_prompt_versions(id,prompt_id,version,source,language,variant,schedule,script,original_format,audio,audio_sha256,duration_ms,state,author_id,created_at) VALUES (?,?,(SELECT COALESCE(max(version),0)+1 FROM hnd_prompt_versions WHERE prompt_id=?),?,?,?,?,?,?,?,?,?,?,?,?)',
   target, promptId, promptId, v.source, v.language, v.variant, JSON.stringify(v.schedule), v.script ?? null, v.original, toBase64(v.audio), hash, v.durationMs, 'draft', authorId, Date.now())] }
}
