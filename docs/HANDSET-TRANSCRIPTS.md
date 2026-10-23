# Supplied transcripts

The native transcript API is a partial foundation for HND-014. It does not run
speech recognition, capture audio, infer a promise or certify consent. There is
no new screen. Existing playback continues to require its independent recording
approval. Original supplied text is retained unchanged, rather than described
as machine output.

An active owner posts to `/api/handset/transcripts` with a completed provider
recording ID, duration in milliseconds, state and explicit confirmation
`authorize supplied transcript for my exact identity`. A `supplied` state needs
one to 200 speaker-labelled segments with unique IDs, English or Spanish,
bounded start and end offsets, text and confidence from zero to one. Confidence
below 0.8 is marked low. A `missing` state needs a reason and accepts no text.
This creates a separate audited, one-hour transcript-text grant for that exact
owner. It confers no audio access or outbound authority.

`GET /api/handset/transcripts` searches currently permitted effective text. It
accepts `q`, `recordingId`, `numberId`, inclusive `from` and `to` epoch-millisecond
bounds and `ownerId` for a cited action or promise owner. Source dates come from
the provider recording record. Search examines at most the latest 50 granted
recordings and reports that bound; it makes no whole-installation coverage
claim. Unsupported filters are refused. Revoked sources and grants contribute
no matches or counts. Search returns at most five matching moments and ten
annotations per recording; detail retains the effective text of every segment
and at most the latest 200 corrections and 200 annotations, with explicit bound
flags. Older history stays in storage. Other communication types and complete pagination remain
open work.

For a transcript ID, the following relative operations are available:

- `GET /api/handset/transcripts/{id}` returns the original, effective segments,
  exact recording offsets, correction history and separately typed annotations.
- `POST /api/handset/transcripts/{id}/corrections` accepts a segment ID,
  replacement `text` and current transcript `revision`. An atomic revision fence
  refuses stale and concurrent conflicting writes. The native actor and time
  remain in history.
- `POST /api/handset/transcripts/{id}/annotations` accepts a segment ID, `kind`
  and `text`. Kinds are summary, topic, sentiment, action and promise. Actions
  and promises require an active named `ownerId` and `dueState` of pending or
  scheduled. Only scheduled items carry a `dueAt` timestamp. A promise also
  requires `I confirm this exact cited promise`; it records the owner's assertion
  without treating that assertion as independently confirmed customer work.
- `POST /api/handset/transcripts/{id}/grants` requires an exact `personId`, an
  `expiresAt` within one hour and `approve this exact person to read transcript text`.
- `POST /api/handset/transcripts/{id}/revoke` accepts an exact `personId` and
  revokes all parallel text grants for that person and transcript.

All operations require a current native session. Writes require the owner and
same-origin proof. Reads require an independent exact-person text grant even for
an owner. Native person and issuing-owner versions, expiry, current number and
source revision are rechecked under database fences; search applies the same
checks before returning any text. Grant changes and reads are audited without
copying transcript content into the audit ledger. No derived index, embedding
cache or model request is created.

Default adopted pending ct: only owners may supply, correct, annotate or grant
text; every reader needs a separate explicit text grant for at most one hour.
A playback grant alone grants no transcript access. Source revocation stops new
text reads and writes; copies already received cannot be recalled. Owner grant
administration never returns text and permits a fresh explicit reader approval
after expiry. Revocation can only remove access and remains available when a
source or reader grant is inactive. Physical retention,
erasure, restore fences and processor deletion are unproved and remain HND-066
obligations. Capture-consent qualification remains HND-013. HND-020, HND-043 and
HND-051 must inherit these source and independent text-access fences before
using this foundation. No DONE claim is made.
