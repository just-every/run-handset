import { rejectedResponse } from './base/rejected-response'
import { createDependencies } from './modules/dependencies/index.mjs'
import { createIdpOwnerClaimHandler, createOwnerClaimHandler } from './modules/owner-claim/index.mjs'
import { firstRunResponse } from './base/setup'
import { fontDocumentResponse } from './base/font-response'
import { createOperatorAuth, createAuthHandler, createSignInHandler, type AuthConfig } from './modules/operator-auth/index.mjs'
import { operatorMail } from './mail.server.mjs'
import branding from './branding.json'
import { appDocument } from './handset/shell'

// The edition's declared theme (public/rer-theme.css), as Base frames link it.
const theme = { href: '/rer-theme.css', productName: branding.name, accentColor: branding.primaryColor }

export interface Bindings {
 DB: D1Database
 /** Built browser files; hosted deploys run the Worker first (staticAssetResponse). */
 ASSETS?: Fetcher
 RER_DEPLOY_SOURCE?: string
 RER_DEPLOY_FINGERPRINT?: string
 RER_VERSION?: { id: string }
 IDENTITY_PROVIDER?: string
 AUTH_ORIGIN: string
 AUTH_LOCAL?: string
 RER_DEV_ORIGIN?: string
 /** Local runtimes only: the checkout's key gate and dev identity switch. Deploy refuses both. */
 RER_MODELS_SERVICE?: string
 RER_MODELS_KEY?: string
 RER_DEMO?: string
 RER_OWNER_CLAIM_ISSUER?: string
 RER_OWNER_CLAIM_INSTALLATION_ID?: string
 RER_OWNER_CLAIM_PUBLIC_KEYS?: string
 RER_DEV_KEY?: string
 RER_DEV_IDENTITY?: string
 RER_INSTALLATION_ID?: string
 RER_MANAGEMENT_ORIGIN?: string
 OWNER_EMAIL: string
 SESSION_SECRET: string
 INSTALLATION_KEY?: string
 INSTALLATION_KEY_PREVIOUS?: string
 SETUP_TOKEN?: string
 MAIL_PROVIDER?: 'development' | 'resend' | 'sendgrid' | 'cloudflare' | 'rer'
 MAIL_FROM?: string
 MAIL_RELAY_URL?: string
 MAIL_API_KEY?: string
 HANDSET_TWILIO_AUTH_TOKEN?: string
 HANDSET_DIAL_ORIGIN?: string
 HANDSET_DIAL_TOKEN?: string
 HANDSET_STRIPE_KEY?: string
 HANDSET_ORBIT_ORIGIN?: string
 HANDSET_ORBIT_TOKEN?: string
 HANDSET_HELPDESK_ORIGIN?: string
 HANDSET_HELPDESK_TOKEN?: string
 MAIL_ACCOUNT_ID?: string
}

export const runtimeBindings = (env: Bindings): Bindings => env.RER_DEV_ORIGIN && env.AUTH_LOCAL === 'true' ? { ...env, AUTH_ORIGIN: env.RER_DEV_ORIGIN } : env
export const authConfig = (env: Bindings): AuthConfig => ({ dependencies: true, origin: env.AUTH_ORIGIN, local: env.AUTH_LOCAL === 'true', OWNER_EMAIL: env.OWNER_EMAIL, SESSION_SECRET: env.SESSION_SECRET, INSTALLATION_KEY: env.INSTALLATION_KEY, INSTALLATION_KEY_PREVIOUS: env.INSTALLATION_KEY_PREVIOUS, SETUP_TOKEN: env.SETUP_TOKEN, MAIL_FROM: env.MAIL_FROM, branding: { productName: branding.name, accentColor: branding.primaryColor, signInPath: '/signin', theme: theme.href } })
export function operatorAuth(env: Bindings) {
 return createOperatorAuth({ db: env.DB, config: authConfig(env), mailSender: operatorMail(env), clientIp: request => request.headers.get('CF-Connecting-IP') ?? '' })
}

const privateHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' }
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

async function handleAuthResponse(request: Request, original: Bindings): Promise<Response | null> {
 const env = runtimeBindings(original), url = new URL(request.url)
 if (url.pathname.startsWith('/.well-known/rer-') || url.pathname.startsWith('/auth/dependencies/')) {
  const linked = await createDependencies({ db: env.DB, INSTALLATION_KEY: env.INSTALLATION_KEY, INSTALLATION_KEY_PREVIOUS: env.INSTALLATION_KEY_PREVIOUS, origin: env.AUTH_ORIGIN, name: branding.name, provider: env.IDENTITY_PROVIDER, local: env.AUTH_LOCAL === 'true', auth: operatorAuth(env), claimOwner: token => createIdpOwnerClaimHandler({db:env.DB,authConfig:authConfig(env),clientIp:()=>request.headers.get('CF-Connecting-IP')??''})(new Request(env.AUTH_ORIGIN+'/auth/owner-claim',{method:'POST',headers:{Host:new URL(env.AUTH_ORIGIN).host,Origin:env.AUTH_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({token})})) }).handle(request)
  if (linked) return linked
 }
 if (url.pathname === '/auth/owner-claim') {
  // The native demo host supplies per-visitor keys; request headers confer no authority.
  // Installed apps retain their linked provider's owner-claim path.
  if (env.RER_DEMO === '1' && env.RER_OWNER_CLAIM_PUBLIC_KEYS) return createOwnerClaimHandler({
   db: env.DB, authConfig: authConfig(env), clientIp: req => req.headers.get('CF-Connecting-IP') ?? '',
   issuer: env.RER_OWNER_CLAIM_ISSUER ?? '', installationId: env.RER_OWNER_CLAIM_INSTALLATION_ID ?? '',
   appOrigin: env.AUTH_ORIGIN, expectedEmail: env.OWNER_EMAIL, publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS),
  })(request)
  return createIdpOwnerClaimHandler({db:env.DB,authConfig:authConfig(env),clientIp:req=>req.headers.get('CF-Connecting-IP')??''})(request)
 }
 // The shared server-rendered sign-in page: plain forms that work before any script.
 if (url.pathname === '/signin') {
  const page = await createSignInHandler(operatorAuth(env), {
   defaultReturnTo: '/setup',
  })(request)
  if (page) return fontDocumentResponse(page)
 }
 if (url.pathname.startsWith('/auth/')) {
  const response = await createAuthHandler(operatorAuth(env))(request)
  if (url.pathname === '/auth/signout' && response?.status === 204 && request.headers.get('accept')?.includes('text/html')) {
   const headers = new Headers(response.headers)
   headers.set('location', '/signin')
   return new Response(null, { status: 303, headers })
  }
  return fontDocumentResponse(response)
 }
 if (url.pathname === '/setup' || url.pathname === '/app' || url.pathname.startsWith('/app/')) {
  const setup = await firstRunResponse(request, env, operatorAuth(env), { theme })
  if (setup) return setup
 }
 if (url.pathname === '/app') {
  const session = await operatorAuth(env).getSession(request)
  if (!session) return new Response(null, { status: 303, headers: { ...privateHeaders, location: '/signin' } })
  const links = (rows: [string, string][]) => `<ul class="hs-links">${rows.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join('')}</ul>`
  return appDocument('Home', `<p class="hs-sub">Signed in as ${escape(session.operator.displayName)}</p><div class="hs-home"><section><h2>Daily work</h2>${links([['/app/cases', 'Shared cases'], ['/app/front-desk', 'Front desk'], ['/app/recordings', 'Recordings'], ['/app/queues', 'Queues']])}</section><section><h2>Settings</h2>${links([['/app/audit', 'Audit'], ['/app/grants', 'Application grants'], ['/app/admin/bulk', 'Bulk administration'], ['/app/admin/templates', 'Templates'], ['/app/reports/queues', 'Queue reports'], ['/app/protection', 'Protection'], ['/app/import', 'Move in']])}</section></div><form method="post" action="/auth/signout"><button type="submit" class="hs-secondary">Sign out</button></form>`)
 }
 return null
}

export async function authResponse(request: Request, original: Bindings): Promise<Response | null> {
 const response = await handleAuthResponse(request, original)
 return response ? rejectedResponse(request, response) : null
}
