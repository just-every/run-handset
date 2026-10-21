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
Prepared instructions remain pending audio receipt. Agent bridging, verified
wait estimates and voicemail/receptionist delivery are unqualified; a native
reservation is not an answered call. An unavailable selected destination is
disclosed, never represented by a fabricated delivery. HND-006/007/031 provide
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
prevent carrier reception or charges. Real pre-reception fax admission, SIP
registrar enforcement, screening and paid outbound adapters remain unqualified.
HND-001/003/011/024/031 must apply current protection and consent at their actual
effect boundaries; HND-004 retains qualified emergency delivery and HND-027
inherits scoped personal-policy administration.
