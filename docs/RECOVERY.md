# Missed-call recovery API

Native owners open an owned recovery with `POST /api/handset/recovery`, selecting
`callRecordId`, `dueAt`, `maxAttempts` (one to three) and optionally `queueEntryId`.
The call must be a signed Twilio unanswered inbound record from a currently
consented source. Repeated legs on the existing correlated customer case return
one recovery. The optional queue entry must belong to that same case; its
original queue, priority, queued time and visit are preserved without requeueing.
An existing DNC or opt-out suppresses contact.

`GET /api/handset/recovery` lists a bounded window with truncation and overdue
indicators. `POST /api/handset/recovery/{id}/{action}` requires `revision`.
Actions: `takeover`, `stop`, `decline`, `escalate` (each with an evidence note),
`assign` (active owner and note), `callback-proposal` (timezone and dueAt), and
`resolve` (same-case receptionist outcomeId with a confirmed booking readback).
A callback proposal makes no call. Human takeover disables proposals and the
scheduler only escalates overdue work to its existing named owner. It never
retries customer contact. An answered transport or delivered text cannot close
a need. The historical booking receipt is explicit evidence, not a new claim
that an appointment remains current forever.

This slice does not implement text-back, actual callback attempts, first-caller
consent capture, reply routing or dynamic need splitting.
Actual contact must use HND-011/017/031/089 and the existing dialer approval,
licensed-registry, local-time and budget controls; no source permission supplies
outbound authority. Native-owner-only management, no autonomous contact and
explicit human decline evidence are conservative defaults pending ct.

The native owner screen `/app/recovery` exposes these actions, the named
owner, due time in UTC, suppression reason, attempt bound and preserved queue
evidence. Human takeover removes callback proposal controls. Same-case booking
resolution requires independently confirmed outcome evidence; a person can
record customer decline with a note. Stale forms refuse rather than changing
a newer revision. The screen discloses its 200-case window.

HND-017 adds owner-approved virtual hold and callbacks on top of these recoveries;
see docs/CALLBACKS.md. A recovery resolves from a callback only after the carrier's
own staff-leg readback shows a conversation.

## Reviewed automatic task intake

At `/app/recovery`, expand **Settings: missed-call intake** and approve the exact
source, IANA timezone and weekly local hours. The approving current native owner
receives new tasks. The API is `POST /api/handset/recovery/policies`, with
`sourceId`, the expected `revision`, `timezone`, `hours` in the existing weekly
window format and `confirm` set to `approve owned missed-call intake`.
`POST /api/handset/recovery/policies/revoke` takes `sourceId` and `revision`.
Approvals and revocations append versions; an older approval never becomes current
again. The native form preserves submitted values when a timezone or hours review
is refused. All configured windows are shown before replacement approval.

Without that current approval, canonical records and manual recovery still work,
but automatic intake is off. Intake evaluates the final provider timestamp in the
reviewed timezone, including the opening instant and excluding closing. Older
missed outcomes are not backfilled by a new approval. Twilio timestamps have
whole-second precision. Source withdrawal, a number correction, a newer policy or
an owner authority change fences the same transaction that creates the task.

The canonical event door, terminal queue offer readback and terminal queue voice
door all use the same intake. It independently reads the exact inbound parent and
the complete child list, then reads each child. A failed staff offer while the
parent remains active creates nothing. A completed staff conversation, a live or
unavailable child, ambiguous listing, foreign identity or missing final timestamp
cannot be labelled an unanswered call. Provider retry after an interrupted
readback can finish intake without creating a second task. Retained queue place
is copied into a new recovery; an existing recovery keeps its owner, due time,
queue evidence and human or terminal decision. Each newly observed call retains
its own missed evidence even when it shares the existing need.

This approval grants no contact permission: it creates neither a text permission
nor a callback attempt, and cannot enroll marketing. STOP or DNC remains visible
on held work. HND-089 keeps the separate one-reply consent path; HND-017 keeps its
explicitly requested callback path. Automatic task ownership does not qualify a
real carrier callback or handset receipt. Fresh needs after a terminal recovery
still require explicit case work; automatic separation of those needs remains
unproved under HND-017 and HND-073. HND-047 retains accountable evidence and
HND-065 and HND-066 retain complete archive and erasure composition.

Conservative task-intake default ADOPTED pending ct: exact-source weekly hours,
current owner approval and ownership, no automatic contact, and no automatic
reopening or reassignment of an existing human decision. This is additional to
the separately adopted caller-requested callback default. HND-017 stays PARTIAL.
