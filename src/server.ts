import { withDemo } from './modules/demo/index.mjs'
import { rejectedResponse } from './base/rejected-response'
import start from '@tanstack/react-start/server-entry'
import { Hono } from 'hono'
import { dispatch } from './base/dispatch'
import { staticAssetResponse } from './base/static-assets'
import { deploymentHealth } from './base/deployment-health'
import { lobbyResponse } from './base/lobby'
import { setupStateResponse } from './base/setup-state'
import { authResponse, runtimeBindings, type Bindings } from './auth.server'
import { identity } from './identity'
import { twilioResponse } from './handset/providers/twilio'
import { applicationResponse } from './handset/authority/application'
import { observeAuth } from './handset/audit/auth'
import { productResponse } from './handset/http/product'
import { privateDoorResponse } from './handset/http/private-doors'
import { importResponse } from './handset/import/doors'
import { protectionCarrierResponse } from './handset/protection/doors'
import { runDueReports } from './handset/metrics/schedules'
import { queueProviderResponse } from './handset/queues/provider'
import { tickQueues } from './handset/queues/tick'
import { dialerProviderResponse } from './handset/dialer/provider'
import { tickDialer } from './handset/dialer/tick'

const api = new Hono<{ Bindings: Bindings }>()
api.get('/health', (context) => context.json({ status: 'ok', ...deploymentHealth(context.env) }))

// Start documents keep their own cache policy and add no-transform, so no proxy
// rewrites the HTML React hydrates (Cloudflare's email address obfuscation
// honours it; src/base/hydration/README.md).
function noTransform(response: Response): Response {
  const headers = new Headers(response.headers), policy = headers.get('cache-control')
  headers.set('cache-control', policy ? `${policy}, no-transform` : 'no-transform')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default withDemo<Bindings, ExportedHandler<Bindings>>({
  async fetch(request, env, execution) {
    const protection = await protectionCarrierResponse(request, env)
    if (protection) return protection
    const queue = await queueProviderResponse(request, env)
    if (queue) return queue
    const dialer = await dialerProviderResponse(request, env)
    if (dialer) return dialer
    const source = await twilioResponse(request, env)
    if (source) return source
    const application = await applicationResponse(request, env)
    if (application) return application
    const imports = await importResponse(request, env)
    if (imports) return imports
    const denied = await privateDoorResponse(request, env)
    if (denied) return denied
    const asset = await staticAssetResponse(request, env)
    if (asset) return asset
    const auth = await observeAuth(request, env, () => authResponse(request, env))
    if (auth) return auth
    const product = await productResponse(request, env)
    if (product) return product
    // The installed variant: the Lobby at / and the public claim state it reads.
    // Local dev serves the saved origin's data at its own port (RER_DEV_ORIGIN).
    const state = await setupStateResponse(request, runtimeBindings(env))
    if (state) return state
    const lobby = await lobbyResponse(request, runtimeBindings(env), identity)
    if (lobby) return lobby
    return rejectedResponse(request, await dispatch(request, () => api.fetch(request, env, execution), async () => noTransform(await start.fetch(request))))
  },
  async scheduled(event, env) {
    await tickQueues(runtimeBindings(env))
    await runDueReports(runtimeBindings(env), event.scheduledTime)
    await tickDialer(runtimeBindings(env))
  },
} satisfies ExportedHandler<Bindings>)
