# Scoped REST API v1

The current versioned root is `/api/handset/v1`. Send the explicitly issued
application credential as `Authorization: Bearer …`. Native cookies confer no
application authority. The native owner issues or revokes exact case/tool
selections at `/app/grants`; every request rechecks the current owner/grant,
expiry and revocation. Credential values never enter URLs or logs.

Read the current OpenAPI 3.1 document at `/openapi.json` under that root.
Supported resources are:

- `GET /cases?limit=20&cursor=…`: `case.read` over exactly selected cases,
  stable case-ID order, at most 50 items and a nextCursor. A foreign cursor
  refuses rather than revealing another record.
- `GET /cases/{id}`: current selected case and linked native records.
- `POST /drafts`: `comment.draft`, `{caseId,text}` and a required
  `Idempotency-Key`. Identical key/body replays the original unpublished draft;
  a changed body conflicts. The draft and replay receipt commit atomically.
- `POST /prepare`, `/execute`: existing exact reviewed-work contract;
  unqualified external effects remain held.
- `POST /mcp`: existing scoped JSON-RPC tools. Standard MCP authorization,
  discovery and external-agent qualification remain unimplemented.

There are 60 requests per credential per fixed UTC minute. `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset` and 429 `Retry-After` describe the
bucket. Buckets survive restart and remain bounded in storage. Errors use
`{error: code}`; changed payload or concurrent idempotency claims use 409.
Scoped refusals retain opaque credential attribution without the requested foreign
record, payload or token. Retry a concurrent claim with the same unchanged key. Credential revocation
is checked before rate limiting.

This slice does not provide qualified same-number Glove/Placemat SMS/replies,
all call/message state webhook subscriptions, consent-filtered media streams,
number management, flow publication, recording/transcript reads or standard
MCP authorization. These remain explicit HND-030 obligations; no unsupported
endpoint is advertised as implemented. Future HND-011/013/027/031/048/049
permissions and provider/consent safeguards must apply at each new door.
