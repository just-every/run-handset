# Native case records and audit

`/app/cases` is the native owner and exact-number teammate workspace. Plain forms use the existing edition
frame, fonts and theme. No marketing or logo is changed. JSON clients use the
same current-session checks under `/api/handset`. Writes require the configured
origin; every transaction repeats current native session, version, role and
expiry checks. Native roles grant no implicit teammate or external-application access. Owners can explicitly grant exact-number canonical work and inbound source consent, or separate exact-person installation audit read/export. These capabilities expire within 24 hours and bind target and issuing-owner native versions. HND-027 retains finer company/location/team and custom-role scopes; the 24-hour capability ceilings are conservative defaults pending ct.

## Records and shared work

- `GET/POST /api/handset/cases`, `GET/POST /api/handset/cases/:id` list, create,
  read and correct accountable work. POST corrections carry the reviewed version;
  conflicts return HTTP 409 with the current record and retained history.
  Owner and due promise change atomically. Closing requires a human reason and
  neither clears due work nor changes any communication outcome.
- `POST /api/handset/records`, `GET /api/handset/records/:id` create and inspect
  immutable typed records, stable source IDs, occurred/received times, links,
  parent transfer legs and correction references. Retrying an exact source ID is
  idempotent; a changed source payload is a conflict. Every reference must exist;
  case-scoped sources cannot link across cases.
- Native entry is an **unverified observation**, not a carrier import, delivery
  receipt, media upload or paid-effect API. Transport observations may be draft,
  unknown or uncertain. They cannot assert delivered or answered. Provider and
  media clauses must add verified producers with their own evidence.
- List query fields are `q`, `status`, `ownerId`, `due` (overdue/scheduled),
  `unread` and `handled` (0/1). `POST /api/handset/filters` saves a named query
  for the current person. Comments and mentioned person references are immutable
  native records on a case. The API returns at most 201 cases with `limited`
  set when more than 200 match; no completeness claim is made for larger lists.

## Exact-number teammate authority

The owner grants `{personId,personVersion,numberId,expiresAt,
confirm:"approve exact person number work and inbound source consent"}` through
`POST /api/handset/sources/access` or the form on `/app/sources`. The native
person and number record are exact selections; the person version is checked
again inside the write. `GET .../access` is owner-only inventory and
`POST .../revoke-access` with `{accessId}` revokes all parallel grants for that
person and number. Historical number records remain valid retained-case scopes;
source consent still requires the current number revision.

Teammates can list/read/edit cases only while every associated number is covered.
The query applies scope before filtering and pagination. The write transaction
rechecks the exact set of case numbers, native authority and every capability;
assignment requires a currently scoped assignee. Linked record views omit foreign
case references, children and reverse links. Record-source replay/conflict paths
cannot expose another case. Case creation and new canonical administrative
objects remain owner-only. Teammates may append comments, dispositions, promises
and uncertain/unknown message observations. These are observations, never sends,
recording capture or provider completion.

The source consent records the native consenting person/version and exact
capability used; historical `owner_id`/`owner_version` columns retain those
values for compatibility. Source revocation preserves evidence. Role/status,
issuing-owner or capability changes suspend later ingestion; restoring a role
requires a new explicit capability and consent. These metadata capabilities do
not imply independently owner-approved queue/media, playback, dialer, audit,
port or administrative authority. One-day work/audit capability maxima and the
owner-only creation restrictions are adopted conservative defaults pending ct.

## Audit controls and limits

Every current product write and its audit entry commit together. Native auth
mutations append a durable uncertain attempt before entering the shared native
handler, then append a correlated terminal response receipt. An interrupted
operation retains uncertainty instead of losing all audit or inventing success.
Public admission attempts remain anonymous until a verified session exists.
No request body is read or retained by the observer. Events hold
only server-generated opaque actor/subject IDs, fixed action/outcome vocabulary,
an applied policy revision and server time. Current policy values encode the
**handset-authorization-v3** schema and the actual native session role/version,
source consent revision, application grant, standing policy or exact approval,
executive line/delegation and playback grant used by the door. Only opaque IDs
and integer revisions are retained, never a caller-supplied policy string.
Existing **owner-only-v1** and **handset-authorization-v2** ledgers remain
verifiable after later policy changes; earlier hashes are never rewritten. Hashes chain over the exact ordered event
fields. Concurrent appends retry on the predecessor/sequence uniqueness fence.
SQL triggers refuse updates and deletes to records, history, audit and restored
ledgers. Normal product roles have no mutation endpoint for those ledgers.

`GET /api/handset/audit` pages by sequence (`after`); `/app/audit` is its native screen. Owner approval through `POST /api/handset/audit/access` grants one exact person installation-wide read, with a separate `allowExport` flag. The request names `{personId,personVersion,expiresAt,allowExport,confirm:"approve exact person installation audit access"}`. `GET .../access` is owner-only inventory; `POST .../revoke` with `{grantId}` revokes every parallel audit capability for that person. Current native session, target/issuer versions, role, expiry and revocation are repeated before response release. Archived full ledgers require export authority too. Restore, anonymization and grant administration remain owner-only; these grants convey no recording access. `GET /api/handset/audit/export` verifies the complete current chain and
returns its terminal checkpoint. Exports over 10,000 events fail explicitly;
there is no silently truncated export. An owner must keep the checkpoint in
independent storage they control. A database administrator can drop triggers or
replace a whole chain. Hashes alone do not prove authenticity against that
administrator; comparing the external trusted checkpoint does. No hosted anchor,
third-party telemetry or immutable-infrastructure guarantee is claimed.

`POST /api/handset/audit/restore` accepts `{archive, expectedCheckpoint,
confirm:"restore evidence only"}` (maximum 2 MiB). It validates exact schema,
fixed vocabulary, every hash and sequence, and the separately supplied trusted
checkpoint. It stores the original evidence as an immutable separate ledger,
not as current authority. Repeat checkpoints are idempotent. Read it at
`GET /api/handset/audit/archive/:checkpoint`. This is audit evidence restore;
HND-065 still owns complete installation archives and inactive effect restoration.

`POST /api/handset/audit/anonymize` accepts `{operatorId,
confirm:"anonymize audit identity"}`. Only an already inactive non-owner may be
selected. It removes the audit attribution mapping; original opaque rows and
hashes survive. It does not erase native identity, source content or other
product stores. HND-066 owns full person erasure and provider cleanup.

HND-013/027 (playback and cross-team approval), HND-001/002 (number actions),
HND-006 (flow publish/rollback), HND-011/089 (consent), HND-044 (payment),
HND-030/036 (external attempts), and HND-049 (applications) inherit the obligation
to commit their decisions/effects with opaque audit. Their future operating
journeys are not certified by this implementation.

## Application credentials and exact authority

`/app/grants` reuses the native frame for scoped issuance, reviewed work and
revocation. `/app/grants/consent` is the MCP owner-consent entry point.
`GET/POST /api/handset/mcp/consent` is the corresponding authenticated native
owner door. POST requires `confirm:"approve scoped credential"`, a name,
`expiresAt` no more than 90 days away, and `definition`:

```json
{"scopes":["read"],"tools":["case.read"],"records":["selected-case-id"],"numbers":[],"recipients":[],"budgetCents":0,"policyRevision":"owner-only-v1"}
```

IDs must select actual native cases, numbers and people. Each selected case
includes its native linked records; no recording bytes or provider authority is
implied. Tokens are 256 random bits, shown once and stored only as a SHA-256
hash. GET `/api/handset/grants` never returns token hashes. Grant authority is
invalid immediately when revoked, expired or when the issuing owner's current
role/status/version no longer matches. Signing out a human session does not
implicitly change that person's separately issued credential grants.

The independently authenticated transport is `/api/handset/application/*`.
Only these exact paths are dispatched before the native namespace fence. They
require `Authorization: Bearer <credential>` and recheck their configured Host
and any supplied Origin. A human cookie cannot elevate an application. There is
no public callback or signature bypass.

- `GET cases/:id`: selected native case read (`read`, `case.read`).
- `POST drafts`: `{caseId,text}` stores an unpublished draft (`draft`,
  `comment.draft`), not a comment, message, approved promise or outbound effect.
- `POST mcp`: JSON-RPC initialize, tools/list and tools/call over the same
  scopes; there is no approval, self-promotion or credential-minting tool.
- `POST prepare`: `{state,approvalId|standingId,idempotencyKey}` checks scopes,
  selected records/numbers/recipients, exact policy/case revision and budget.
  Optional caller instructions are inert data and never supply authority.
- `POST execute`: `{jobId,state}` repeats current authority, exact reviewed
  state, case revision and current human/standing approval. **Every external
  job remains held_adapter_unqualified with effectOccurred:false.** No carrier,
  port, media, flow or send success is claimed. The future qualified adapter must
  add effect-time STOP, local hours, consent, eligibility and actual receipt.

A state binds operation, case ID/version, number ID, sorted recipient snapshot,
USD cents, flow revision, policy revision and reviewed content. Native owner
`POST /api/handset/grants/approve` accepts `{grantId,state,expiresAt,
confirm:"approve exact reviewed state"}`. Each approval is single-use when
reserving a job. Material changes require fresh approval, even if they remain
within the grant. Port signing is refused without a qualified human attestation
door; generic approval cannot supply an LOA. Cross-team/media reads and
outside-policy commitments remain refused without their qualified doors.

Standing call bounds are approved through native owner
`POST /api/handset/grants/policy` with `{grantId,bounds,expiresAt,
confirm:"approve standing call bounds"}`. Bounds select a number, recipients,
maxCents, maxListSize, flowRevision and policyRevision. They authorize only
in-bounds paid-call snapshots; a new campaign always needs exact approval.
`POST /api/handset/grants/policy/:id/revise` includes the reviewed revision and
records a fresh human-approved revision. Existing jobs retain their exact checked
snapshot and approving person/revision and refuse execution after a bounds
change. Applications cannot approve or revise a policy.

Reservations share the transaction with grant/approval fences, idempotency and
audit. Their aggregate cannot exceed the grant budget. They represent held work,
not charges. Owner `POST /api/handset/grants/jobs/:id/cancel` releases a held
reservation. `POST /api/handset/grants/:id/revoke` cancels all pending jobs,
releases reservations and preserves completed draft/read/authority evidence.
HND-021/030 and all qualified effect producers inherit the final atomic authority
and audit checks; the current held state does not prove those future effects.

## Explicit human sponsorship

The installation owner uses `POST /api/handset/grant-scopes` with
`operatorId`, an exact grant `definition`, `permissions`, `expiresAt`, and
`confirm: "delegate exact application authority"`. Permissions are individually
selected from `issue`, `approve`, and `standing`. Each immutable delegation binds
the current named person and issuing owner versions, exact cases, numbers,
recipients, tools, policy revision and maximum budget per application grant.
No native role grants these permissions automatically. Review is within 90 days.
A delegated person cannot redelegate these human permissions.

A current native person can issue a subset through `POST /api/handset/grants`
or `POST /api/handset/mcp/consent`, approve an exact state through
`POST /api/handset/grants/approve`, or create standing call bounds through
`POST /api/handset/grants/policy`, only with the corresponding explicit permission.
Their delegation must cover the whole application definition and the resulting
review lifetime. Caller outcome work remains outside these delegations. The
owner console, inventory, secret rotation and administrative revocation remain
owner-only; delegated native forms are still pending.

`POST /api/handset/grant-scopes/:id/revoke` accepts an empty object from the
owner. It cancels only work authorized by that scope and releases each held
reservation once. Every credential use and pending execution checks the bound
scope and both current people again. A new scope never revives old credentials.
Historical grants, approvals and checked lists retain their authorizing person.
The conservative default is owner-issued exact-person permission with no new
provider effects; ct approval of this delegated API policy remains pending.

Application secret expiry is independent of the review date and is at most
24 hours. Owner `POST /api/handset/grants/:id/rotate` returns the replacement
secret once and preserves reviewed scopes and approval revisions. Individual
`POST /api/handset/grants/approval/:id/revoke` and
`POST /api/handset/grants/policy/:id/revoke` cancel only their linked pending work.

## Carrier price observations and recording links

On a signed carrier call record, the owner can select **Read carrier price** or
use `POST /api/handset/records/:id/usage-receipt` with
`confirm: "read exact billed usage"`. This reads the exact Twilio Call resource;
it never changes the call or charges an account. Account, call, both endpoints,
terminal state, USD unit and provider times must match before a usage record is
appended to the same case and call. Current native owner and source consent are
checked again after the network read.

The original provider price string and exact integer USD millionths are retained.
Positive `amountMicrousd` means a charge and negative means a credit; no fractional
cent is rounded away. A repeated observation returns the original stable record.
A newer provider correction appends a superseding record; a stale or conflicting
provider time cannot replace it. Carrier price observation never proves an invoice
was reconciled, a payment settled or a customer outcome completed. Other billed
usage producers and full invoice reconciliation remain separate work.

Case timelines and source records link to the existing recording player in
English and Spanish. Viewing the metadata grants no playback permission: the
player still requires separate exact-person owner attestation, provider identity
readback and current consent checks before bytes are released. This linkage does
not prove capture consent, retained media custody or bilingual transcription.

## Verified Twilio source records

Owners or native people holding exact-number work capability explicitly authorize a selected native business-number record and account
at `/app/sources` or `POST /api/handset/sources` with
`{accountId,numberId,confirm:"authorize signed inbound records"}`. The account
is an identifier, never an authentication credential. The installation supplies
`HANDSET_TWILIO_AUTH_TOKEN` as a private Worker binding; it is never accepted in
an HTTP form, persisted in D1, exported or shown on a screen. This binding is
installation-local. Current ingestion does not claim HND-048 rotation/custody
qualification or HND-031 carrier activation.

`POST /providers/twilio/events` is a declared public network-edge door. It checks
its exact configured URL and Host, form content type, body bound and Twilio's
HMAC-SHA1 signature over the complete URL and every sorted form parameter.
Only then does it resolve the authorized account and number; a native cookie
cannot substitute for that proof. Conflicting duplicate fields are refused.
Revoked sources and changed/inactive consenting-person or scope authority are refused on every event
and again in the same transaction as receipt/record/audit persistence. An account
can authorize several numbers, each with separate consent revisions. Revocation
or a change to the consenting person or number capability suspends admission until fresh explicit
consent for that account and number. The source screen shows active, suspended
and revoked revisions. A native number correction suspends its old source;
fresh consent must name the current immutable number record. Queue, protection,
dialer and delegated-effect fences share the current-source check, and restoring
a role never reactivates an old signed queue binding. Earlier sources and linked evidence remain retained;
a new source revision does not silently reactivate old routing/endpoint grants.

Supported official callback fields cover call-status legs (`CallSid`,
`ParentCallSid`, `SequenceNumber`, `Timestamp`, `CallStatus`), message/MMS
(`MessageSid`, `MessageStatus`/`SmsStatus`, `Body`, `NumMedia`, `MediaUrlN`,
`MediaContentTypeN`), and recording metadata (`RecordingSid`, `CallSid`,
`RecordingStatus`). A callback missing a provider timestamp requires an
identity-matched read-only Message/Recording REST receipt; failed, redirected,
foreign or timestamp-free readback creates no communication fact. Audio and
images are not downloaded. Recording metadata does not prove a consented
voicemail capture or playable recording.

A received event retains immutable source/event IDs, a request digest, provider
occurred time and independent received time. Exact retries reuse the receipt;
changed payloads under the same event key conflict. Later status changes append
provider-attempt records linked to the original canonical call/message ID,
without inflating communication counts. MMS media metadata has its own stable
record linked to that original message. Transfer children received
before their parent remain explicitly pending and are drained when the parent
arrives. Number/caller correlation keeps call legs, recording references and MMS
on one case; carrier completion never closes the case or clears a human promise.
The source readback edge is a fake in tests using documented provider fields;
no live carrier qualification is claimed. `POST /api/handset/sources/revoke`
with `{sourceId}` stops further admission and preserves completed receipts.

## Current action families and on-behalf accountability

Native `/app` and `/api/handset` doors for records, grants, audit, sources,
administration, queues, reports, protection, dialer, front desk and recordings,
and native import doors retain an uncertain request receipt before dispatch and
an opaque correlated response receipt afterwards. A 202 remains uncertain. These
receipts describe HTTP handling, never a paid effect or completed customer work.
Existing transactional decision/effect audit remains in place. Current external
application and signed carrier doors retain their independent scoped-actor audit.
New family producers must append atomic audit with their own authority fences.

On-behalf events additionally retain an opaque principal. The principal extends
the ordered hash input only when present; preexisting rows and independently kept
checkpoints remain valid. Exports and restored ledgers verify that field too.
Anonymizing a native person removes their mapping, not the operational actor or
principal references. Product erasure remains HND-066. No names, numbers, call
text, URL/query/body, provider payload or credentials enter the audit observer.

## Front desk and exact recording approval

`/app/front-desk` and `/api/handset/front-desk` use native sessions. Owner POST
`lines` approves an exact executive, business-number record, current inbound
source, timezone, weekdays, local hours, DND and optional explicit forwarding
configuration. Same-day hours are supported; unsupported overnight intervals are
refused. Saving a line policy alone never configures the carrier. A policy edit revokes
old assistant grants rather than silently enlarging them.

Owner POST `delegations` requires `lineId`, `assistantId`, `expiresAt` (at most
one day) and `confirm:"approve exact assistant and executive line"`. POST
`revoke` stops subsequent operations on every session immediately and revokes
all parallel grants for the same assistant/line pair without ending any call. Assistant reads expose only current granted lines and source-linked
calls. Presence POST changes only the current person's state; lamps older than
90 seconds display unknown. A lamp never proves receipt or audio.

POST `operations` accepts the delegation, reviewed line revision, kind
(pickup/park/transfer/callback), source-linked call ID, an exact destination where
needed and idempotency key. It rechecks all current people/source authority and
line policy atomically. **Requests start held.** The owner must separately approve the exact call
move or independently qualified single-recipient callback before execution.
The UI supports ordinary keyboard request, execution and reconciliation. Actual
receiver audio and received business identity remain HND-034's live
qualification obligations; official-schema readback is not human outcome proof. No delegated recording, port or admin right
is implied. HND-007/008/009/031 inherit endpoint and carrier control qualification.

`/app/recordings` provides explicit owner approval and revocation forms.
POST `/api/handset/recordings/grants` requires an existing completed provider
recording, exact native `personId`, expiry at most one hour and
`confirm:"approve consented recording for this exact person"`. This human
attestation does not prove capture consent, jurisdiction or US custody (HND-013 /
HND-046). No role, including owner, implies playback rights. POST
`recordings/grants/:id/revoke` revokes immediately. Delegation never supplies a
grant. Exact-person approval applies to everyone and does not imply team or
supervisor roles. These are owner-attested playback grants; no automatic capture,
sharing, download copy or outbound work is introduced.

GET `/api/handset/recordings/:id/playback` verifies an exact current-person grant,
current source/issuer/person authority and provider recording/account/parent-call
readback. It fetches only the constructed Twilio WAV URL with redirects refused,
requires a bounded declared size (10 MB maximum), and rechecks revocation before
fetch and before release. It never persists bytes or returns a provider URL or
credential. Every attempted/permitted/refused/failed playback is attributable. A refused
playback uses installation scope, not a recording subject. Recording
download/export/share and consent-change doors remain unbuilt.
Network-edge tests use generated synthetic WAV data, not captured speech. Live
capture/media/carrier qualification remains open. Future retention/erasure gates
must bind this producer before HND-013/065/066 claim their wider lifecycle proof.


### One-shot call controls

Owner POST `front-desk/approve` selects one held `operationId`, at most five
minutes of approval lifetime, `maxSeconds` (1–3600), optional callback `listId`,
and `confirm:"approve this exact existing call move or single callback"`.
For pickup/transfer, the selected native operator must have an owner-approved
route and an independently read-back active single-agent conference. A transfer
target is that exact native operator ID, never an arbitrary external phone. Park
uses a private conference derived from the opaque operation ID. Parent-call
account, source, direction, From/To and current state are read back. No new
outbound leg or recording is created by moving that existing inbound call.

The assistant POSTs `front-desk/execute` with the operation ID and
`confirm:"execute exact approved call request"`. It repeats current line,
delegation, source, issuer, endpoint and exact approval predicates. A durable
uncertain record commits before the single provider write; no retry reissues it,
even after a lost response or process restart. A provider acknowledgment never
becomes completed pickup/park/transfer. POST `front-desk/reconcile` requires
identity-matched current conference membership with exactly the expected caller
and endpoint, and records only `provider_observed`; human audio stays unqualified.
Revocation denies subsequent execution and leaves unrelated/preexisting calls
alone. Approval expiry requires a new request, never mutation of the old review.

A callback additionally requires an existing exact one-recipient preview list,
matching line source, assistant representative and requested destination. It uses
the established dialer qualification, current consent/DNC/time/state registry
checks, atomic budget reservation and exact assistant's independently connected
endpoint. The delegation adds a current authority fence to every dialer write and
immediately before its one network effect. No campaign or general manager scope
is conveyed. Callback readback retains provider From/To, assistant and conference
identity separately from actual controlled-receiver proof. Live qualification requires installation-authorized carrier credentials and
controlled receiving endpoints. Protocol fixtures do not establish real receiver
audio or externally displayed business identity.

## Executive inbound policy at the carrier edge

Owner POST `/api/handset/front-desk/routing` (or the native form) separately
approves `{lineId,lineRevision,revision?,delegationId?,voicemailUrl,maxSeconds,
expiresAt,confirm:"approve exact inbound coverage voicemail and forwarding"}`.
It snapshots the selected assistant's approved Client/SIP endpoint, the existing
consent-qualified external voicemail service and the line's explicit forwarding
destination. Approval lasts at most one day and bounds connected time to at
most one hour. These are product defaults, not proof of carrier pricing or audio.
Saving does not change provider configuration or place a call.

The signed `/providers/twilio/protection` voice webhook identifies the selected
account **and called number**, applies nuisance/emergency screening first, then
applies the exact current executive line. Explicit external forwarding takes
precedence; outside-hours calls redirect to the approved voicemail service;
DND sends calls to the active delegated assistant's unchanged approved endpoint,
or voicemail if that assistant/endpoint was revoked. Normal calls continue to
the existing principal route. Screening completion repeats this policy, rather
than bypassing it. No local capture or new recording consent is invented.

A line edit invalidates its old inbound approval. Suspended source/owner, stale
line/route, revoked endpoint, expired approval or ambiguous line cannot authorize
a new assistant dial or external forward. A durable uncertain instruction
receipt is committed before TwiML is returned. A repeated call webhook is
refused, even after a restart, rather than redialing after a lost response.
Each Dial noun supplies the signed POST called-party URL
`/providers/twilio/protection/executive/:receipt/answer`. Before allowing the
existing leg to bridge, it reads back the exact parent and child calls and
rechecks the source, line, approval and delegated endpoint. Revocation while
ringing, a changed line or a foreign child yields Hangup; no second Dial or
carrier REST write is issued. The authorization receipt retains applied
revisions and does not assert media delivery.
Already-bridged calls remain alone. A one-shot Dial ends after its bounded
connection/no-answer; Handset does not claim the remote phone rang, a person
answered, a voicemail was captured, or the receiving display distinguished the
assistant from the executive. Those require authorized live qualification.
