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

`/app/exports` and `/api/handset/exports` require a current native owner or admin
at every request and again in authorizing transactions. CSV references grant
no media access. Connector creation and revocation, exact archive approval and
sensitive scheduled-email policy require the current owner. Each archive file
release also repeats exact-person recording and transcript grants, current
connector approval, retention deadline and export authority. The SFTP buyer
command obtains its own native email session and calls these same artifact and
receipt doors; it cannot borrow a browser profile or bypass media grants.
`tests/handset-reporting.mjs` proves current authority and revocation, including
restricted supervisor refusal. See `docs/CALL-EXPORTS.md` for all four sinks,
separate buyer custody and inherited HND-065 and HND-066 obligations.

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

Agents use `/app/queues/self` and `/api/handset/queues/self` for only their own existing queue memberships, availability and wrap-up. Mutations repeat current native session checks in the write transaction; agents cannot add memberships or change another person, capabilities, priorities or routing policy.

Handset has native record, audit, source and application-grant handlers described in
`docs/HANDSET-RECORDS.md`. Each repeats native authorization at its own door and
inside authorizing transactions. Exact-number native work capabilities permit scoped canonical cases and inbound source consent; exact-person audit capabilities permit read and separately approved export. Capability administration, audit restore/anonymization and canonical object creation stay owner-only. No work or audit capability implies recording access. The exact `/api/handset/application/*` transport is
dispatched before the native fence and independently requires a current scoped
bearer credential; it never borrows a cookie. MCP owner consent remains behind
the native session fence. Recording bytes require the independent exact-person playback grant described below. There are
no Start server functions. Accepted signed Twilio ingress includes
`/providers/twilio/events`, `/providers/twilio/queues/:id` and its offer callbacks,
`/providers/twilio/protection` and its challenge/executive-answer callbacks, and
`/providers/twilio/dialer/:id/{answer,status}`, inventoried below; unimplemented
carrier paths return no data and cause no effect.
HND-030 inherits API and generated-handler authorization; HND-013, HND-027,
HND-048 and HND-092 inherit private media/export authorization; HND-031 and
HND-036 inherit provider-specific signed callbacks with narrow authority.
Those future clauses must prove their own implemented doors. Their signatures,
product permissions and carrier qualification are not proved by a current 404.

Prompt recording and test callbacks under `/providers/twilio/prompts` require
their exact signed URL and narrowly bound call identity. Carrier WAV reads at
`/providers/twilio/prompts/audio/:testId/:versionId/:capability.wav` require the
exact test-bound capability, an approved version, an unexpired started test and
its current selected-number source. They return no-store audio. Source
withdrawal fences each fetch; replacement consent cannot revive an old test.
Native preview requires the current owner session or the exact current greeting-draft role scope. See
`docs/MEDIA-SECURITY.md` for the bounded external-flow declarations.

`tests/handset-auth.mjs` exercises the emitted Worker and actual numbered D1
migrations with production auth. These auth tests substitute only the SendGrid network edge
in ordinary CI. `tests/handset-auth-browser.mjs` drives native forms at 1440 and
390. With `HANDSET_LIVE_MAIL=1`, it uses the configured SendGrid sender and
controlled receipt mailbox; development/demo admission is never enabled.

The narrowly declared signed exceptions are:

- `POST /providers/twilio/events`: bounded official event ingestion, with no
  outbound effect.
- `POST /providers/twilio/queues/:id` and
  `POST /providers/twilio/queues/:id/offers/:offerId/{status,action}`: inbound
  queue call control and offer callbacks, with provider parent/child readback
  and owner-approved agent and overflow routes. Dial instructions can incur
  carrier charges; emitted instructions do not prove audio delivery.
- `POST /providers/twilio/protection` and
  `POST /providers/twilio/protection/challenges/:id/:round`: voice/SIP admission
  and bounded screening rounds, with approved continuation/emergency redirects,
  challenge prompts and refusal instructions.
- `POST /providers/twilio/protection/executive/:id/answer`: called-party
  authorization for an already emitted executive-line Dial. Exact signed
  parent/child readback and current source, line, routing and assistant authority
  are required before the existing leg bridges; refusal hangs up that leg.
- `POST /providers/twilio/dialer/:id/{answer,status}`: existing-attempt callbacks
  bound to account, From/To and provider call readback. Answer instructions
  require current source, list, qualification and recipient eligibility before
  bridging to a preconnected agent; status readback records observed outcomes.

All require installation-local HMAC-SHA1 signatures, exact URL/origin and Host,
POST form content and bounded request bodies. Events, queue and protection
handlers require an active owner-authorized, unrevoked source; queues also
require a current owner-authorized binding. Dialer bridge eligibility repeats
current source and owner-approval checks. These are exercised with synthetic
signatures and a substituted provider edge, not live carrier traffic. See
`docs/HANDSET-RECORDS.md`, `docs/HANDSET-CONSOLES.md` and the signed-source/refusal
tests in `tests/handset-records.mjs`, `tests/handset-queues.mjs` and
`tests/handset-outbound.mjs`. Every other carrier
path retains the native namespace fence and ordinary refusal.

Native front-desk and owner-attested recording doors are now inventoried in
`docs/HANDSET-RECORDS.md`. `/app/front-desk` and
`/api/handset/front-desk/*` require current native sessions and exact line
delegation; owner-only grants never imply admin, port or media authority.
`/app/recordings` and `/api/handset/recordings/*` require native sessions; playback
also requires the exact-person recording grant independently inside its handler.
No recording bytes are static or public. Current requests are audited by fixed
action family without retaining request content. Held call requests cause no provider call. Separately approved one-shot call
controls and their provider readback are documented above; they certify no
human pickup, park, transfer or received callback identity without live proof.

Executive-line inbound approvals use the existing owner-only
`/api/handset/front-desk/routing` and `/app/front-desk/routing` doors. The signed
protection webhook applies their exact line/route/source revisions after
protection screening, including on a Gather completion. The called-party answer
door rechecks authority before bridging, including revocation while ringing.
No carrier REST write, recording capture or delegation right is introduced.

## Follow-up, recovery and rule APIs

`/api/handset/followups`, `/api/handset/recovery`, `/api/handset/rules` and
`/api/handset/delivery` require a current native owner session and same-origin
writes at the product boundary. Bearer credentials cannot approve or publish
these operations. Delivery is a read-only inventory. No new provider ingress
namespace or media access was added. Signed existing missed-call and STOP
ingress only queues native work or suppresses obsolete contact. Worker
scheduled handling retains the rule outbox and owned overdue escalation.
See FOLLOWUPS.md, RECOVERY.md, RULES.md and DELIVERY.md for limits and held
customer/receiving-system obligations. HND-105 inherits finer role scope;
HND-013/018/089 retain actual capture/contact consent and caller identity.

`/api/handset/operations` and `/api/handset/compliance` require native owners
and same-origin writes. Assessments/preparation do not grant repair, filing,
legal, address, rotation or spend authority. Fixed-origin provider GETs check
the selected source and receipt identity; exports discard raw private fields.

`/api/handset/v1/*` independently authenticates the current scoped application
credential before the native namespace gate. Exact selected-case reads and
unpublished drafts share existing grant checks; cookie-only access refuses.
The v1 draft receipt is atomic and its rate bucket durable. Future resources,
signed event/media subscription delivery and standard MCP authorization remain
HND-030 work, with HND-013/027/048/049 authorization and custody inherited.

The native owner consoles `/app/rules`, `/app/followups`, `/app/recovery` and
`/app/operations` reuse these same native API implementations for all forms.
Each form checks same-origin sessions before dispatch and the same current
authority, revision and source fences inside its mutation. Operations exports
are available from the assessment card under the same owner boundary.


Explicit owner-managed human application scopes use
`/api/handset/grant-scopes` and its exact revoke child. Only the existing native
POST credential issuance, exact approval and standing-policy doors accept a
current delegated person; owner inventory and administration remain restricted.
Bearer applications cannot enter those native doors or delegate human authority.
See `docs/HANDSET-RECORDS.md` for the exact selected permissions and revocation.
The owner-only usage receipt child on a source call reads carrier price and
rechecks current source consent before appending canonical facts. It grants no
outbound effect or playback access. Compliance follow-up and case history use the
same current native owner checks as the existing compliance API.


The preparatory `/api/handset/quality` human-review API uses native sessions and
same-origin mutations. Owners administer exact team capabilities and supplied
text intake. Explicit supervisors correct scores and coach; agents comment only
on their own assigned reviews. All content reads and writes also require an
independent current exact-recording approval. Export and employee-note scopes
are separate explicit permissions. Source, person and capability revocation are
fenced before releasing content. This adds no recording, transcript, model or
customer-contact authority. See `docs/QUALITY.md` for the remaining HND-020 work.
The native `/api/handset/transcripts` namespace is documented in
`docs/HANDSET-TRANSCRIPTS.md`. Every operation requires a native session. Owner
writes and independent exact-person transcript-text grants are checked inside
the handler; a recording playback grant does not authorize text retrieval.
Current source and number revisions fence detail, search and changes. The API
is a supplied-text foundation with a native search and correction console at
`/app/transcripts`, without a speech processor or model transport. HND-020, HND-043 and HND-051 inherit these text and source checks.

The owner-only `/api/handset/flows` namespace stores preparatory immutable
versions, native path tests and exact publication or rollback approvals. It
authorizes no carrier effect. See `docs/HANDSET-FLOWS.md`.

## Explicit call text consent and surveys

Current native owners use `/app/consent`, `/api/handset/consent`,
`/app/surveys` and `/api/handset/surveys`. The native session, origin and owner
checks precede each operation; audited writes repeat current native ownership.
The consent policy, recipient local-hours review, recording-permission
attestation and verbal consent are separate explicit native actions.

Additional signed Twilio exceptions are `/providers/twilio/consent/:sourceId`,
its `/calls/:id/decision` and `/calls/:id/outcome` descendants,
`/providers/twilio/consent/texts/:id/status`,
`/providers/twilio/consent/messages/:id/status`, and
`/providers/twilio/surveys/:id` with its consent, rating and reply descendants.
They require the installation-local exact-URL signature, scalar form fields,
Host and origin binding and current source and policy authority. Call and message
identities have independent provider readback. Only the exact owner-approved
staff Dial and one purpose-permitted text can produce an external effect. A
missed-call reply never grants survey or marketing permission. The shared signed
event webhook also correlates actual inbound survey replies. See
`docs/CALL-CONSENT.md` for effect-time fences and physical-receipt limits.


Scoped recovery work uses the native session and origin gate at
`/app/recovery` and `/api/handset/recovery`. The recovery handler independently
checks exact-number capabilities and current assignment before reads and writes;
its SQL transaction repeats session, person, issuer, fallback, expiry, assignment
and capability checks. Only owners create manual needs, administer intake and
grant or revoke recovery scope. Staff scheduling and waiting cancellation use
the recovery child actions and retain the callback policy checks. Before a
provider creation the claim rechecks the current worker and scope. No recovery
grant changes contact policy or grants outbound authority by itself.

## Company agent door

`/mcp` and the two native MCP aliases share one dispatcher.
`/.well-known/oauth-protected-resource/mcp` names its canonical resource.
`/api/rer/agent-policy` authenticates signed Business policy independently of
browser sessions. `/agents` and `/agents/api/*` retain native person sessions,
same-origin mutation controls and named-person approval checks. Agent tokens
cannot act as a person's approval or Pause control. See AGENT-ACCESS.md for the
current core capability declaration and the held native preparation limits.
