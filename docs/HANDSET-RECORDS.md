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
responses are observed without reading or retaining request bodies. Events hold
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
