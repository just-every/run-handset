import { operatorAuth, runtimeBindings, type Bindings } from '../../auth.server'
import { rejectedResponse } from '../../base/rejected-response'

const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

// Keep private files behind the same boundary as documents, before ASSETS.
// Public HTTP ownership is documented in docs/HTTP-DOORS.md. Auth handlers
// separately check sessions and capabilities at each native operation.
export async function privateDoorResponse(request: Request, original: Bindings): Promise<Response | null> {
  let path: string
  try { path = decodeURIComponent(new URL(request.url).pathname) }
  catch { return rejectedResponse(request, Response.json({ error: 'invalid_path' }, { status: 400, headers })) }
  const document = within(path, '/app')
  if (!document && !['/api', '/media', '/_server'].some(root => within(path, root))) return null
  const env = runtimeBindings(original), url = new URL(request.url)
  const failure = (error: string, status: number) => rejectedResponse(request, Response.json({ error }, { status, headers }))
  if (url.origin !== env.AUTH_ORIGIN || request.headers.has('host') && request.headers.get('host')?.toLowerCase() !== url.host.toLowerCase()) return failure('invalid_host', 403)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && (request.headers.get('origin') !== env.AUTH_ORIGIN || request.headers.get('sec-fetch-site') === 'cross-site')) return failure('invalid_origin', 403)
  try {
    if (await operatorAuth(env).getSession(request)) return null
    if (!document || !['GET', 'HEAD'].includes(request.method)) return failure('unauthenticated', 401)
    return new Response(null, { status: 303, headers: { ...headers, location: `/signin?returnTo=${encodeURIComponent(url.pathname + url.search)}` } })
  } catch { return failure('auth_unavailable', 503) }
}
