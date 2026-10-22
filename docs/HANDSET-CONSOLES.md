# Administrative and operational consoles

Open these from the signed-in workspace. They use the installation's native
session and origin checks; provider URLs verify signatures separately.

## Local bulk administration

`/app/admin/bulk` previews user and device CSV additions and changes outside
migration. The screen supplies the column headers. Email identifies a user;
normalized MAC identifies a device. Extensions are unique across these native
profiles. Name, location and emergency address are required. Emergency mapping
is stored configuration, not a carrier validation receipt.

Every source row has its validation errors, diff, local USD cost and authority
requirements in the saved plan. Local configuration is free. Provider purchases,
invitations, registration, live number assignment and live routing are separate
effects and remain held here; unavailable provider prices are not quotes.

Approve the exact saved hash before Apply. Apply commits bounded batches with
durable row receipts and a cursor. Reopen its plan to resume. Reapplying a
completed plan returns the same result without new records or charges. Native
user accounts are pending invitation, with no credential or automatic mail.
Use native operator invitation separately to admit an employee.

`/app/admin/templates` keeps immutable versions of hours, ring rules, keys and
greeting defaults. Select exact profile IDs, inspect the diff and approve it.
Independent overrides win. Changed profiles, template versions, expired plans
or changed approval authority refuse apply. Templates do not alter consent,
call state, flow versions or native role grants.

Native owners and admins use this console. Admins can manage member profiles,
but cannot change owner/admin targets or grant elevated roles. Members and
greeting-only phone profiles get no bulk authority. HND-027 inherits finer
company/location/team/number capabilities and the greeting self-service door;
HND-001/004/006/007 retain their separately qualified activation obligations.

## Queues

`/app/queues` configures native queues, agent languages/skills, priority,
longest-idle or round-robin capacity reservations, wrap-up and explicit overflow.
Global presence and each queue login are independent. Logout prevents new
reservations but does not delete active assignments. Restart reconciles expired
leases; active media is never inferred to have ended merely from process loss.
The Worker cron also reconciles native deadlines and dispatches eligible work.

Authorize a current inbound source and queue on this screen to obtain a signed
Twilio Voice URL. The edge reads the official Call resource, preserves source
identity and emits English/Spanish position Say/Pause/Redirect instructions.
Prepared instructions remain pending audio receipt. `/app/queues/media`
approves an exact existing Client or SIP agent address and the existing HTTPS
voicemail/receptionist destination. Source activation refuses a missing selected
overflow route. A durable offer is saved before its one-shot Dial instruction;
a lost response never repeats Dial. Signed child/action callbacks and explicit
reconciliation independently read the parent and child, exact destination and
source identity before changing reservation state. Ringing, provider-connected,
completed and actual audio receipt are separate facts. Revoking a route or queue
membership preserves active work. A maximum-wait cancellation targets only an
unanswered child and reads back its outcome; it never completes an active call.

Qualified estimates disclose completed-service samples, wrap and current staffed
capacity. Without samples the estimate is unavailable. Transfer/overflow retain
one stable parent and separate queue visits. Existing approved HTTPS overflow
routes receive a Redirect for this same caller; emitted routing instructions do
not establish voicemail capture or receptionist receipt. Actual receiver,
bidirectional audio, announcements and delivery remain unqualified. An unavailable
selected destination is disclosed, never represented by a fabricated delivery. HND-006/007/031 provide
the qualified flow, endpoint and carrier paths; HND-019/069 retain actual media
and capacity qualification. HND-027 inherits scoped non-owner administration.

## Queue metrics and reviewed move-in

Use `/app/import` for a `queue-dataset` JSON object or array. The shared Base
door owns upload, plan, exact fingerprint approval, bounded apply, native
reconciliation and preserving Undo. Imports create inert historical metric
observations. See `src/handset/metrics/model.ts` for the validated format and
`tests/helpers/handset-metrics.mjs` for a synthetic example.

`/app/reports/queues` versions each queue's T, S, short-abandon policy,
service-level method, `[start,end)` arrival cohort and display timezone. Raw
totals and source entry identities accompany every ratio. Zero denominators
are unavailable. Callback work keeps its parent call and adds no inbound
arrival. Agent segments must not overlap; staffed time excludes break and
logged-out states. Logged-in time includes break and excludes logged-out time.

Live and retained historical reports use the same event and formula versions.
Changing formulas never changes source observations. Provisional entries are
named and cannot be finalized. Historical snapshots retain their original
configuration and source revisions after later changes.

An explicit owner consent schedules one report to that current owner's mailbox.
The Worker cron claims a due job before sending once through the configured
mail transport. Accepted, failed, uncertain and development outcomes are
separate. An uncertain send is not retried automatically. HND-022 inherits
recurring DST schedules, broader authorized recipients and the remaining
analytics; HND-019 inherits wallboard integration. HND-065/066 retain complete
export/erasure of dataset and shared import custody. No automatic age pruning
is introduced. Business imports stay closed until complete installation trust
exists and the owner explicitly enables them.

## Nuisance and fraud protection

`/app/protection` manages owner and personal voice/fax nuisance policies, exact
number/prefix/anonymous matches, allow exceptions, audited callback designations,
binding outbound consent stops, admission attempts and containment alerts.
Direct 911 and exact, unexpired designated emergency callbacks bypass nuisance
rules. Outbound DNC/consent stops cannot be removed by inbound allow rules.
Owner rules precede personal rules; within each scope allow exceptions precede
blocks/screening, with exact numbers then longer prefixes resolving ties.

The signed Twilio admission URL may redirect an allowed inbound voice caller
only to an explicitly approved existing HTTPS flow. It never emits paid Dial
instructions. Compromised-device attempts are attributed and contained; attempted
USD is a configured maximum estimate, not a carrier charge receipt. Normal
callers and designated callbacks retain their approved continuation.

Native fax intake can be withheld; a post-reception fax notification cannot
prevent carrier reception or charges. Screen rules emit bilingual DTMF Gather
instructions. Each call retains bounded attempts, expiry and exact signed
source/account/call/caller/number scope. A consumed round cannot reset attempts;
success continues at most once through the current approved route. Changed
source/owner/rule authority cancels old challenges; current explicit allow and
designated callback exceptions take precedence. A digit establishes interaction,
never human identity or outbound consent. The console shows progress without the
expected response. Actual audible screening, pre-reception fax admission, SIP
registrar enforcement and paid carrier qualification remain unqualified.
HND-001/003/011/024/031 must apply current protection and consent at their actual
effect boundaries; HND-004 retains qualified emergency delivery and HND-027
inherits scoped personal-policy administration.

## Blended outbound controls

`/app/dialer` records exact owner-approved audiences and purposes. Native case
and consent observations alone grant no calling permission. Each recipient needs
an explicit, current owner verification tied to its consent evidence, exact
purpose and modes and clear company, national, state and campaign suppression
checks. Unknown or stale checks, a superseding consent record, a stop and quiet
hours hold the recipient. Standing approvals snapshot exact limits and CRM owner;
they never choose an Orbit audience or waive recipient checks.

Preview, progressive, power, bounded parallel and predictive sessions retain
cursors and per-attempt dispositions. Predictive eligibility uses observed
provider outcomes and attributed human dispositions; unknown, insufficient or
breached observations hold prediction. Current staffed capacity reserves the
configured inbound share, pauses on inbound breaches and shares atomic slots
with native inbound queues. An independently connected waiting human agent and
its exact approved conference are read back before recipient creation.

Every launch is an explicit owner action with exact approval and budget. The
attempt and capacity reservation commit before the paid Calls request. An
uncertain create is read back and never retried automatically or released by
restart. Answer-time checks preserve current consent and waiting-agent authority;
an unavailable agent gets only the qualified safety message and termination,
never indefinite hold. Pausing or revocation stops new launches and preserves
connected work. Provider-connected and customer-confirmed outcomes stay distinct.

External qualification records are audited owner attestations with current native
evidence references and owned-number readback; this console does not certify law
or actual media. Independent provider/media receiver, final legal configuration
and permitted real-traffic qualification remain required before a live campaign
is qualified. ct’s 22 October ruling governs specificity-first nuisance policy, post-911
callback windows, exact source/queue/budget approvals and separate licensed
compliance results. Owner administration remains separate from agent self-service. HND-021 inherits the remaining campaign/CRM
controls, HND-027 scoped representatives, HND-031 actual carrier qualification,
and HND-065/066 complete dialer and screening custody/erasure. No automatic
campaign launch, recording or data pruning is introduced.


## Licensed outbound compliance results and named approval scopes

The owner imports the business's licensed National DNC, applicable state-list and
Reassigned Numbers Database results through `POST /api/handset/dialer/extracts`.
The JSON envelope names `kind` (`national`, `state`, `reassigned`), `jurisdiction`
(`US` or a state such as `US-FL`), `publishedAt`, `expiresAt`, `sourceReference`,
a current native license/provenance `evidenceId`, and `rows`. Each row names the
exact `recipient` and a `status` (`clear`, `blocked`, `reassigned`, `unknown`).
Reassignment results additionally bind `consentId` to the exact native consent
record used for the check. Confirm with `import licensed compliance results`.
An absent number is unknown, never an inferred clear result. These are imports
of licensed source results, not a live Registry subscription or provider/legal
certification. The business must retain its actual license and source receipts.

The newest extract governs, including missing and blocked rows; a newer partial
extract never falls back to an older clear result. National, state and RND
extracts older than 31 days or past their declared expiry hold calling. Native
company and campaign stops remain binding. Approval and each dial repeat these
checks beside a separate, at-most-one-day human verification. Imported results
never grant consent, audience selection or automatic launch authority.

`POST /api/handset/dialer/state-rules` records one reviewed jurisdiction's
`startMinute`, `endMinute`, `maxAttempts`, rolling `windowHours`, `writtenModes`,
current native `evidenceId` and `reviewAt` (at most 90 days), confirmed with
`approve reviewed state calling rules`. Updates require the current `revision`.
Calling uses the intersection with the recipient's local window and counts
attempts across lists and sources. Florida rows cannot extend past 20:00 or
permit more than three attempts in 24 hours. Every required written-consent
mode needs current `writtenConsentEvidenceId` on the recipient. Unknown state
rules hold calling. `POST /api/handset/dialer/state-preview` is an owner-only
simulation with an explicit `at` time; it grants no authority and cannot dial.
Paid launch handlers always select their own current clock.

`POST /api/handset/dialer/approver-scopes` lets the owner grant an active named
person exact `sourceIds`, `queueIds`, `budgetCents`, manager standing-policy
power (`standing` 0 or 1), and `reviewAt`, confirmed with
`grant exact campaign approval scope`. Updates require `revision`; revoke via
`POST /api/handset/dialer/approver-scopes/revoke` with `operatorId`. Named
approvers can POST exact lists and managers can POST policies within those
bounds. They cannot read the owner's global console or administer compliance,
qualification or scopes. Current native authority and scope are repeated inside
the transaction and at launch; a wider list, expired/revoked scope or policy is
refused. Lists, policies and qualification have explicit review dates of at most
90 days. Scopes are a narrow campaign capability; HND-027 retains product-wide
roles, revocation, media and actual custody duties.

Agents can POST `/api/handset/dialer/ready` only for themselves. Current provider
readback must show the exact preconnected agent on the owner-approved route.
A different agent or a fabricated provider result is refused. Each launch repeats
media readback and preserves uncertain and connected work on later revocation.
The console displays imported source dates, state bounds and approval scopes;
all global reads remain owner-only. Actual licensed dataset, provider/legal
qualification and controlled real traffic remain required before live operation.

A console protection check places no emergency call and opens no post-911 window;
only an actual authenticated carrier admission opens that callback access.
