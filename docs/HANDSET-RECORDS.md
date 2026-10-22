# Native case records and audit

`/app/cases` is the native owner workspace. Plain forms use the existing edition
frame, fonts and theme. No marketing or logo is changed. JSON clients use the
same current-session checks under `/api/handset`. Writes require the configured
origin; every transaction repeats current native session, version, role and
expiry checks. The temporary conservative policy is **owner-only-v1**. It grants
no member, administrator, supervisor or external application implicit access.
HND-027 must replace this default with its independently proven finer scopes.

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

## Audit controls and limits

Every current product write and its audit entry commit together. Native auth
mutations append a durable uncertain attempt before entering the shared native
handler, then append a correlated terminal response receipt. An interrupted
operation retains uncertainty instead of losing all audit or inventing success.
Public admission attempts remain anonymous until a verified session exists.
No request body is read or retained by the observer. Events hold
only server-generated opaque actor/subject IDs, fixed action/outcome vocabulary,
a policy revision and server time. Hashes chain over the exact ordered event
fields. Concurrent appends retry on the predecessor/sequence uniqueness fence.
SQL triggers refuse updates and deletes to records, history, audit and restored
ledgers. Normal product roles have no mutation endpoint for those ledgers.

`GET /api/handset/audit` pages by sequence (`after`); `/app/audit` is its owner
screen. `GET /api/handset/audit/export` verifies the complete current chain and
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
`expiresAt` no more than one day away, and `definition`:

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

## Verified Twilio source records

Owners explicitly authorize a selected native business-number record and account
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
Revoked sources and changed/inactive owner authority are refused on every event
and again in the same transaction as receipt/record/audit persistence.

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
refused. Saving configuration never activates forwarding. A policy edit revokes
old assistant grants rather than silently enlarging them.

Owner POST `delegations` requires `lineId`, `assistantId`, `expiresAt` (at most
one day) and `confirm:"approve exact assistant and executive line"`. POST
`revoke` stops subsequent operations on every session immediately without ending
any call. Assistant reads expose only current granted lines and source-linked
calls. Presence POST changes only the current person's state; lamps older than
90 seconds display unknown. A lamp never proves receipt or audio.

POST `operations` accepts the delegation, reviewed line revision, kind
(pickup/park/transfer/callback), source-linked call ID, an exact destination where
needed and idempotency key. It rechecks all current people/source authority and
line policy atomically. **Requests stay held. No qualified live media client or
exact spend approval exists here; no carrier or audio effect occurs.** The UI
supports ordinary keyboard form operation and shows that hold explicitly. Actual
shared-line pickup, parking, transfer and received business identity remain
HND-034's open acceptance obligations. No delegated recording, port or admin right
is implied. HND-007/008/009/031 inherit endpoint and carrier control qualification.

`/app/recordings` provides explicit owner approval and revocation forms.
POST `/api/handset/recordings/grants` requires an existing completed provider
recording, exact native `personId`, expiry at most one hour and
`confirm:"approve consented recording for this exact person"`. This human
attestation does not prove capture consent, jurisdiction or US custody (HND-013 /
HND-046). No role, including owner, implies playback rights. POST
`recordings/grants/:id/revoke` revokes immediately. Delegation never supplies a
grant. These conservative defaults await ct approval; no automatic capture,
sharing, download copy or outbound work is introduced.

GET `/api/handset/recordings/:id/playback` verifies an exact current-person grant,
current source/issuer/person authority and provider recording/account/parent-call
readback. It fetches only the constructed Twilio WAV URL with redirects refused,
requires a bounded declared size (10 MB maximum), and rechecks revocation before
fetch and before release. It never persists bytes or returns a provider URL or
credential. Every attempted/permitted/refused/failed playback is attributable.
Network-edge tests use generated synthetic WAV data, not captured speech. Live
capture/media/carrier qualification remains open. Future retention/erasure gates
must bind this producer before HND-013/065/066 claim their wider lifecycle proof.
