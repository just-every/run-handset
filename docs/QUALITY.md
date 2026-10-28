# Human quality review

The native API prepares cited **human** reviews. It does not transcribe audio,
run an AI scorer, certify recording consent or approve model recalibration.
Owner-supplied text remains labelled as such on every read and export. A human
score is never counted as an AI score or as evidence of a customer outcome.

All doors below start with `/api/handset/quality`. They require current native
sessions; mutations also require the configured origin. Application credentials
cannot administer teams, supply text, approve access or override a score.

- `POST /teams`: an owner creates a named team.
- `POST /grants`: an owner selects `teamId`, exact `personId`, `role` (`agent`
  or `supervisor`), independent booleans `privateNotes` and `export`, and
  `expiresAt` (epoch milliseconds, at most 24 hours). Confirm with
  `approve exact quality access without recording rights`. Agents cannot receive
  employee-note permission. No native role implies quality access.
- `POST /grants/{id}/revoke`: revoke every parallel quality capability for that
  person and team. It does not grant or change recording access.
- `POST /rubrics`: an owner with an explicit supervisor capability supplies
  `teamId`, `expectedRevision` (zero initially), and `criteria`, each with
  unique `id`, `label` and integer `maxScore` between 1 and 100. Publication
  appends a new revision. Existing reviews retain their exact original rubric.
- `POST /reviews`: an owner with a supervisor capability supplies `teamId`,
  `callId`, `recordingId`, `agentId`, `rubricId`, `segments` and `grades`.
  Confirm with `attest permission for supplied text human review only`.
  The recording must belong to that exact canonical call, have current verified
  completed metadata and duration, and be separately approved for the actor.
  The agent needs an active agent capability in the selected team. A call has
  one review; duplicate intake refuses rather than overwriting it.
- `GET /reviews/{id}`: read an authorized review, its preserved score chain and
  permitted comments. Agents see only their own assigned reviews. Supervisors
  see only teams with an explicit current capability. Every reader, including
  the owner, needs a separate current grant for that exact recording.
- `GET /reviews/{id}/export`: the same content checks plus explicit `export`
  permission. Employee notes remain omitted without `privateNotes` permission.
  Responses are private and never cached.
- `POST /reviews/{id}/override`: an explicitly granted supervisor supplies
  the current `scoreId` and complete corrected `grades`. A stale score refuses.
  The original and every correction remain immutable.
- `POST /reviews/{id}/comments`: supply `scoreId`, exact `segmentId`, `kind`
  and `body`. Supervisors attach `coaching`; the assigned agent attaches
  `self_review`. `employee_note` requires the separate supervisor note scope.
  These comments have no customer-visible summary or outbound delivery door.

Each supplied segment has a unique `id`, `startMs`, `endMs` and `text`. Moments
are ordered, do not overlap and fit within the provider-observed duration.
Each grade names one `criterionId`, bounded integer `score`, exact `segmentId`,
`explanation` and `uncertainty`. Every rubric criterion must appear exactly once.
The server does not assert that supplied text matches speech. Missing media or
unknown capture permission cannot be transformed into verified AI evidence.

Current native person versions, issuing owner versions, expiry, revocation,
source authority and recording completion are fenced in the same transaction
as writes and immediately before releasing stored review content. Revoking a
recording or its source also blocks stored text and coaching. An already
received export cannot be recalled. Quality actions retain opaque audit receipts
without copying excerpts, scores, notes or employee names into the audit ledger.

This is a preparatory API with no new browser screen. HND-020 remains partial:
whole-week accounting, actual consent-qualified call transcription and AI
scoring, held-out human agreement and reviewed recalibration, and the complete
browser journey at both required widths are still missing. The conservative
interim access policy above awaits ct approval. HND-013 and HND-014 retain
capture and transcript qualification, HND-105 inherits broader scoped role
administration, HND-076 inherits current recording checks and HND-110 holds the separate
measured-coaching outcome. No personnel action is automated.
