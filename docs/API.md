# Scoped REST API v1

The versioned root is `/api/handset/v1`. Send the explicitly issued
application credential as `Authorization: Bearer …`. Native cookies confer no
application authority. The native owner issues exact case and tool selections
at `/app/grants`; every request rechecks the current owner, grant, review date,
secret expiry and revocation. Credential values never enter URLs or logs.

Read the OpenAPI 3.1 document at `/openapi.json` under that root.
Supported resources are:

- `GET /cases?limit=20&cursor=…`: `case.read` over exactly selected cases,
  stable case-ID order, at most 50 items and a nextCursor. A foreign cursor
  refuses rather than revealing another record.
- `GET /cases/{id}`: current selected case and linked native records.
- `POST /drafts`: `comment.draft`, `{caseId,text}` and a required
  `Idempotency-Key`. Identical keys and bodies replay the original unpublished
  draft; a changed body conflicts. Draft and replay receipt commit atomically.
- `POST /prepare`, `/execute`: exact reviewed work; unqualified external
  effects remain held.
- `POST /mcp`: JSON-RPC initialization, initialized notification, ping,
  tool discovery and scoped tool calls. Discovery supplies input schemas for
  current supported doors. Tool results include text content and matching
  structuredContent. Draft calls require `Idempotency-Key`, using the same
  per-grant receipt as REST; retries through either door survive restart.
  Unqualified recording reads and attestation tools are not advertised.
  Standard MCP authorization discovery and OAuth remain unimplemented.

There are 60 requests per credential per fixed UTC minute. `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset` and 429 `Retry-After` describe the
bucket. Buckets survive restart and secret rotation; errors use `{error: code}`.
Changed payload or concurrent idempotency claims return 409. Retry a concurrent
claim with the same unchanged key. Authentication precedes rate limiting.
Scoped refusals retain opaque credential attribution without the requested
foreign record, payload or token.

## Review and revoke authority

An owner chooses a grant review date up to 90 days away. Every issued secret
expires within 24 hours and no later than that review date. The native
`POST /api/handset/grants/{id}/rotate` door returns a new secret once and
immediately invalidates the previous secret, including in-flight effect checks.
Rotation preserves selected scopes, budgets, approval revisions and receipts;
it cannot reactivate an expired or revoked grant or a changed sponsor.

An owner independently revokes an exact approval at
`POST /api/handset/grants/approval/{id}/revoke` or a standing policy at
`POST /api/handset/grants/policy/{id}/revoke`. Both are available as text-labeled
controls on `/app/grants`. Revocation atomically cancels only linked pending
jobs and releases their reservations once. Historical reviewed state and human
attribution remain. Unrelated approvals and grant reads remain usable.
Applications and admins cannot invoke these owner-only controls. Approvals and
standing bounds still expire within one day and cannot outlive the grant.

Qualified same-number Glove and Placemat SMS with real replies, complete call
and message state subscriptions, consent-filtered media streams, number
management, flow publication, recording and transcript reads, and standard
MCP authorization remain HND-030 work. HND-011, HND-013, HND-027, HND-031,
HND-048 and HND-049 permissions and provider safeguards apply at every future
door. Scoped sponsors remain an HND-049 gap, and the manager list policy is HND-107.
