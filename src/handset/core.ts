import { operatorAuth, runtimeBindings, type Bindings } from '../auth.server'
import type { Session } from '../modules/operator-auth/index.mjs'
import { themeFrame } from '../base/theme-frame'
import { fontHead } from '../base/font-head'
import branding from '../branding.json'

export type ObjectValue = Record<string, unknown>
export class Fault extends Error {
 constructor(public code: string, public status = 400, public detail?: unknown) { super(code) }
}
export const policy = 'owner-only-v1'
export const id = () => crypto.randomUUID()
export const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' }
export const json = (value: unknown, status = 200) => Response.json(value, { status, headers })
export const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
export function object(value: unknown): ObjectValue {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Fault('invalid_object')
 return value as ObjectValue
}
export function keys(value: ObjectValue, allowed: string[]) {
 if (Object.keys(value).some(key => !allowed.includes(key))) throw new Fault('unknown_field')
}
export function text(value: unknown, name: string, max = 200, empty = false): string {
 if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Fault(`invalid_${name}`)
 return value.trim()
}
export function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
 if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Fault(`invalid_${name}`)
 return Number(value)
}
export const timestamp = (value: unknown, name: string) => integer(value, name, 0, 8640000000000000)
export function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
 if (typeof value !== 'string' || !choices.includes(value as T)) throw new Fault(`invalid_${name}`)
 return value as T
}
export async function input(request: Request, limit = 65536): Promise<ObjectValue> {
 if (Number(request.headers.get('content-length') ?? 0) > limit) throw new Fault('body_too_large', 413)
 const raw = await request.text()
 if (new TextEncoder().encode(raw).length > limit) throw new Fault('body_too_large', 413)
 try {
  if (request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw))
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Fault('json_required', 415)
  return object(JSON.parse(raw))
 } catch (error) { if (error instanceof Fault) throw error; throw new Fault('invalid_json') }
}
export async function session(request: Request, original: Bindings): Promise<{ env: Bindings; session: Session }> {
 const env = runtimeBindings(original), url = new URL(request.url)
 if (url.origin !== env.AUTH_ORIGIN || request.headers.has('host') && request.headers.get('host')?.toLowerCase() !== url.host.toLowerCase()) throw new Fault('invalid_host', 403)
 if (!['GET', 'HEAD'].includes(request.method) && (request.headers.get('origin') !== env.AUTH_ORIGIN || request.headers.get('sec-fetch-site') === 'cross-site')) throw new Fault('invalid_origin', 403)
 const actor = await operatorAuth(env).getSession(request)
 if (!actor) throw new Fault('unauthenticated', 401)
 return { env, session: actor }
}
export function owner(actor: Session) {
 if (actor.operator.role !== 'owner') throw new Fault('owner_required', 403)
}
export function ownerFence(db: D1Database, actor: Session): D1PreparedStatement {
 // Repeat current native authority inside the same transaction as every write.
 return db.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
 WHERE s.id=? AND s.operator_id=? AND s.operator_version=o.version AND o.role='owner' AND o.status='active'
 AND s.revoked_at IS NULL AND s.expires_at>?`).bind(actor.id, actor.operator.id, Date.now())
}
export async function page(title: string, body: string, status = 200): Promise<Response> {
 const frame = await themeFrame({ href: '/rer-theme.css', productName: branding.name, accentColor: branding.primaryColor })
 return new Response(`<!doctype html><html lang="en"${frame.htmlClass}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Handset</title>${fontHead}${frame.head}</head><body><main>${frame.brand}<nav aria-label="Handset"><a href="/app">Home</a> · <a href="/app/cases">Cases</a> · <a href="/app/audit">Audit</a> · <a href="/app/grants">Application grants</a> · <a href="/app/sources">Sources</a></nav><h1>${escape(title)}</h1>${body}</main></body></html>`, { status, headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'strict-origin', 'content-security-policy': `default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; ${frame.policy}` } })
}
export function field(label: string, name: string, value = '', type = 'text', required = true) {
 return `<label>${escape(label)}<input name="${escape(name)}" type="${type}" value="${escape(value)}" ${required ? 'required' : ''}></label>`
}
export const hidden = (name: string, value: unknown) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`
export async function digest(value: unknown) {
 const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
 return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
