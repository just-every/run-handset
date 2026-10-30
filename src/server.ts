import { handsetAgentDoor } from './handset/agents/door'
import { groupProviderResponse } from './handset/messages/groups'
import { withDemo } from './modules/demo/index.mjs'
import { seedDemo } from './demo'
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
import { tickVoicemail } from './handset/voicemail/delivery'
import { tickMessages } from './handset/messages/provider'
import { tickExports } from './handset/exports/doors'
import { consentProviderResponse } from './handset/consent/provider'
import { callbackProviderResponse } from './handset/callbacks/provider'
import { tickCallbacks } from './handset/callbacks/dial'
import { promptProviderResponse } from './handset/prompts/provider'
import { tickConsentTexts } from './handset/consent/texts'
import { surveyProviderResponse, tickSurveys } from './handset/surveys/doors'
import { twilioResponse } from './handset/providers/twilio'
import { versionedResponse } from './handset/api/v1'
import { applicationResponse } from './handset/authority/application'
import { observeProduct } from './handset/audit/requests'
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
import { tickRules } from './handset/integrations/delivery/outbox'
import { expireKnowledge } from './handset/knowledge/retention'
import { tickRecovery } from './handset/recovery/doors'
import { receptionistProviderResponse } from './handset/receptionist/authorization'
import { businessSettings } from './business.server'

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
    return observeProduct(request,env,async()=>{
    const agent = await handsetAgentDoor(env).handle(request)
    if (agent) return agent
    const business = await businessSettings(runtimeBindings(env)).handle(request)
    if (business) return business
    const groups = await groupProviderResponse(request,env)
    if (groups) return groups
    const consent = await consentProviderResponse(request, env)
    if (consent) return consent
    const callbacks = await callbackProviderResponse(request, env)
    if (callbacks) return callbacks
    const prompts = await promptProviderResponse(request, env)
    if (prompts) return prompts
    const survey = await surveyProviderResponse(request, env)
    if (survey) return survey
    const protection = await protectionCarrierResponse(request, env)
    if (protection) return protection
    const receptionist = await receptionistProviderResponse(request, env)
    if (receptionist) return receptionist
    const queue = await queueProviderResponse(request, env)
    if (queue) return queue
    const dialer = await dialerProviderResponse(request, env)
    if (dialer) return dialer
    const source = await twilioResponse(request, env)
    if (source) return source
    const versioned = await versionedResponse(request, env)
    if (versioned) return versioned
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
    })
  },
  async scheduled(event, env) {
    await tickExports(runtimeBindings(env),event.scheduledTime)
    await tickVoicemail(runtimeBindings(env),event.scheduledTime)
    await tickMessages(runtimeBindings(env))
    await tickConsentTexts(runtimeBindings(env))
    await tickSurveys(runtimeBindings(env))
    await expireKnowledge(runtimeBindings(env))
    await tickQueues(runtimeBindings(env))
    await runDueReports(runtimeBindings(env), event.scheduledTime)
    await tickDialer(runtimeBindings(env))
    await tickRecovery(runtimeBindings(env), event.scheduledTime)
    await tickCallbacks(runtimeBindings(env), event.scheduledTime)
    await tickRules(runtimeBindings(env), event.scheduledTime)
  },
} satisfies ExportedHandler<Bindings>, { seed: seedDemo })

export { HandsetAgentJobs } from './handset/agents/jobs'
