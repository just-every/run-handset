# Handset HTTP doors

The installed app uses Base's native operator table as its allowlist: only
active operators can confirm an email link. Links expire after 15 minutes;
GET and HEAD only preview them, and POST consumes their hash once. Sessions
expire absolutely after seven days (there is no sliding extension), within
the contract's 30-day inactivity maximum. HTTPS cookies are host-only,
Secure, HttpOnly and SameSite=Lax. Sign out revokes the stored session before
redirecting an HTML form back to sign-in. A retained cookie cannot restore it.

## Current public doors

- `GET/HEAD /`: the installed Lobby, separate from run-handset.com's marketing
  site. It shows installation claim state, never private application records.
- `GET/HEAD /signin`: the native email sign-in form. There is no production
  demo or shared-account login. Local development's checkout-key-gated persona
  facility is not a production sign-in method.
- `GET/HEAD /setup/state`: claimed/unclaimed only. `/setup` is an owner document:
  unsigned visitors are sent to sign-in; POST independently requires the
  current owner session, same origin and explicit confirmation.
- `GET /health`: deployment readiness metadata, with no caller or operator data.
- Built theme, fonts, icons and browser assets: public files. No private record
  or media may be published as a static asset.
- Native auth protocol paths: `/auth/magic-link`, `/auth/confirm`,
  `/auth/bootstrap`, `/auth/owner-claim`, `/auth/owner-signin`, and optional
  `/auth/oidc/*`. Each uses its own proof, origin and method checks. Email
  requests, link confirmation and bootstrap are durably throttled by native
  auth (15-minute windows; separate IP and email/token buckets). Unknown and
  inactive email requests have the same accepted response and send no mail.
  Failed or uncertain mail revokes its link and creates no session.
- Dependency discovery: `/.well-known/rer-dependencies`,
  `/.well-known/rer-link/jwks` and its interface children;
  `/auth/dependencies/status` and `/auth/dependencies/callback` use the shared
  installation-link protocol. A callback redeems the pending one-use issuer
  grant; it is not a carrier webhook or browser-session bypass.

The separate marketing build supplies `/run` and `/contract`. There is no
installed docs route (`run.json` declares `docs: false`). Unsupported paths
and methods keep their ordinary 404/405 refusals.

## Current private doors and inherited work

`/app` independently checks a native session when rendering its document.
`/auth/session`, `/auth/operators`, `/auth/sessions`, `/auth/domain-rules`,
`/auth/providers` and `/auth/settings/identity` authorize within their native
handlers. Native operator, invitation, session, profile, domain and provider
mutations each repeat their own current-session/capability and origin checks.
Sign-out itself is a same-origin POST.

The Worker also fences `/app/*`, `/api/*`, `/media/*` and `/_server/*` before
static files or dispatch. Otherwise-admissible unsigned or revoked API/media/
function requests get 401; private GET/HEAD documents redirect to sign-in.
Cross-origin mutations get 403 before effects. This fence does not replace
authorization in a handler. Unknown signed-in routes still return 404.

There are currently no product API handlers, Start server functions, private
media handlers or carrier callbacks. Forged requests to unimplemented carrier
paths return no data and cause no effect; there is no accepted carrier event.
HND-030 inherits API and generated-handler authorization; HND-013, HND-027,
HND-048 and HND-092 inherit private media/export authorization; HND-031 and
HND-036 inherit provider-specific signed callbacks with narrow authority.
Those future clauses must prove their own implemented doors. Their signatures,
product permissions and carrier qualification are not proved by a current 404.

`tests/handset-auth.mjs` exercises the emitted Worker and actual numbered D1
migrations with production auth. Only the SendGrid network edge is substituted
in ordinary CI. `tests/handset-auth-browser.mjs` drives native forms at 1440 and
390. With `HANDSET_LIVE_MAIL=1`, it uses the configured SendGrid sender and
controlled receipt mailbox; development/demo admission is never enabled.
