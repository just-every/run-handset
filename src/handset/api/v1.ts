import { runtimeBindings, type Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { applicationAuth, applicationRead, applicationResponse, draft } from '../authority/application'
import { grantFence, grantPolicy, type Grant } from '../authority/store'
import type { Definition } from '../authority/model'
import { Fault, input, integer, json, keys, text } from '../core'

const root = '/api/handset/v1'
const spec = {
 openapi: '3.1.0', info: { title: 'Handset scoped work API', version: '1.0.0', description: 'Current native cases, unpublished drafts and held reviewed work. Qualified calling, messaging, numbers, flow publication, recording/media and standard MCP authorization remain pending.' },
 servers: [{ url: root }], security: [{ scopedCredential: [] }], components: { securitySchemes: { scopedCredential: { type: 'http', scheme: 'bearer', description: 'Explicit native-owner issued revocable application credential. No human cookies or inherited account permissions.' } } },
 paths: {
  '/openapi.json': { get: { summary: 'Read this current capability contract', responses: { '200': { description: 'OpenAPI document' }, '401': { description: 'Inactive credential' } } } },
  '/cases': { get: { summary: 'List only exact selected native cases', parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }], responses: { '200': { description: 'items and nextCursor; stable selected-case ID order' }, '403': { description: 'Read scope or selected cursor refused' }, '429': { description: '60 requests per credential per minute; Retry-After indicates reset' } } } },
  '/cases/{id}': { get: { summary: 'Read one exact selected case under case.read', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Current native case and linked records' }, '403': { description: 'Case outside current grant' } } } },
  '/drafts': { post: { summary: 'Create one unpublished draft under comment.draft', parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', maxLength: 100 } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['caseId','text'], additionalProperties: false, properties: { caseId: { type: 'string' }, text: { type: 'string', maxLength: 4000 } } } } } }, responses: { '201': { description: 'Unpublished draft' }, '200': { description: 'Same key and same request replay the original draft' }, '409': { description: 'Changed payload or concurrent claim; retry the same unchanged key' } } } },
  '/prepare': { post: { summary: 'Prepare exact reviewed work; unqualified provider effects stay held', responses: { '202': { description: 'Held job with stable idempotency key' }, '403': { description: 'Current scope, grant or exact approval refused' } } } },
  '/execute': { post: { summary: 'Recheck current reviewed work; provider effects remain held', responses: { '202': { description: 'Held, no external effect' }, '403': { description: 'Inactive authority' } } } },
  '/mcp': { post: { summary: 'Existing scoped JSON-RPC MCP tools; standard MCP authorization pending', responses: { '200': { description: 'Scoped tool result' }, '401': { description: 'Credential revoked or expired' } } } },
 },
}
/** Versioned public door: current application credentials, per-grant rate limits,
 * stable selected-case pagination and atomic draft idempotency. */
export async function versionedResponse(request: Request, original: Bindings): Promise<Response | null> {
 const url = new URL(request.url)
 if (url.pathname !== root && !url.pathname.startsWith(root + '/')) return null
 const env = runtimeBindings(original)
 let grant: Grant | undefined, remaining = 0, reset = Math.floor(Date.now() / 60000) * 60 + 60
 const finish = (response: Response) => { const headers = new Headers(response.headers); headers.set('RateLimit-Limit', '60'); headers.set('RateLimit-Remaining', String(remaining)); headers.set('RateLimit-Reset', String(reset)); return new Response(response.body, { status: response.status, headers }) }
 try {
  if (url.origin !== env.AUTH_ORIGIN || request.headers.has('host') && request.headers.get('host')?.toLowerCase() !== url.host.toLowerCase() || request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN || request.headers.get('sec-fetch-site') === 'cross-site') throw new Fault('invalid_origin', 403)
  grant = await applicationAuth(request, env)
  const window = Math.floor(Date.now() / 60000)
  const usage = await env.DB.prepare('INSERT INTO hnd_api_rate VALUES (?,?,1) ON CONFLICT(grant_id,window) DO UPDATE SET calls=calls+1 RETURNING calls').bind(grant.id, window).first<{calls: number}>()
  remaining = Math.max(0, 60 - usage!.calls); reset = window * 60 + 60
  if (usage!.calls > 60) { const response = json({ error: 'rate_limit', retryAfterSeconds: Math.max(1, reset - Math.floor(Date.now() / 1000)) }, 429); response.headers.set('Retry-After', String(Math.max(1, reset - Math.floor(Date.now() / 1000)))); return finish(response) }
  // Keep rate storage bounded without retaining tokens or arbitrary client addresses.
  await env.DB.prepare('DELETE FROM hnd_api_rate WHERE window<?').bind(window - 2).run()
  const path = url.pathname.slice(root.length), d = JSON.parse(grant.definition) as Definition
  if (request.method === 'GET' && path === '/openapi.json') {
   await append(env, grant.id, 'application.read', 'installation', 'completed', [grantFence(env, grant)], null, grantPolicy(grant))
   return finish(json(spec))
  }
  if (request.method === 'GET' && path === '/cases') {
   keys(Object.fromEntries(url.searchParams), ['cursor','limit'])
   if (!d.scopes.includes('read') || !d.tools.includes('case.read')) throw new Fault('record_out_of_scope', 403)
   const cursor = url.searchParams.get('cursor'), limit = integer(Number(url.searchParams.get('limit') ?? 20), 'limit', 1, 50)
   if (cursor && !d.records.includes(cursor)) throw new Fault('cursor_out_of_scope', 403)
   const selected = d.records.filter(key => !cursor || key > cursor).sort(), items = []
   for (const key of selected.slice(0, limit)) items.push(await applicationRead(env, grant, key))
   await append(env, grant.id, 'application.read', 'installation', 'completed', [grantFence(env, grant)], null, grantPolicy(grant))
   return finish(json({ items, nextCursor: selected.length > limit ? selected[limit - 1] : null }))
  }
  const caseMatch = path.match(/^\/cases\/([0-9a-f-]{36})$/)
  if (request.method === 'GET' && caseMatch) return finish(json(await applicationRead(env, grant, caseMatch[1])))
  if (request.method === 'POST' && path === '/drafts') {
   const key = text(request.headers.get('idempotency-key'), 'idempotencyKey', 100)
   if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new Fault('invalid_idempotencyKey')
   const result = await draft(env, grant, await input(request), key)
   return finish(json(result, 'replay' in result ? 200 : 201))
  }
  if (request.method === 'POST' && ['/prepare','/execute','/mcp'].includes(path)) {
   const target = new URL('/api/handset/application' + path, url)
   const response = await applicationResponse(new Request(target, request), env)
   if (response) return finish(response)
  }
  throw new Fault('not_found', 404)
 } catch (error) {
  if (error instanceof Fault) return finish(json({ error: error.code }, error.status))
  if (String(error).includes('UNIQUE constraint failed: hnd_api_idempotency')) return finish(json({ error: 'idempotency_claim_conflict_retry_same_key' }, 409))
  if (String(error).includes('CHECK constraint failed')) return finish(json({ error: 'current_authority_changed' }, 409))
  return finish(json({ error: 'temporarily_unavailable_no_completion_claimed' }, 503))
 }
}
