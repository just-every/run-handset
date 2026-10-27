# Missed-call recovery API

Native owners open an owned recovery with `POST /api/handset/recovery`, selecting
`callRecordId`, `dueAt`, `maxAttempts` (one to three) and optionally `queueEntryId`.
The call must be a signed Twilio unanswered inbound record from a currently
consented source. Repeated legs on an unresolved correlated customer need return one recovery. After resolution or decline a later missed call opens a new need linked to the earlier recovery within the same customer case; the earlier decision stays unchanged. The optional queue entry must belong to that same case; its
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
a need. A confirmed booking outcome can resolve only one recovery need; later needs cannot reuse the earlier resolution. Complete need-specific outcome attribution remains open. The historical booking receipt is explicit evidence, not a new claim
that an appointment remains current forever.

The owner grants exact-person, exact-number recovery capabilities under
**Settings: recovery access**. Each grant requires a current person version,
a named current fallback owner, expiry within one day and an explicit list:
`read`, `work`, `takeover`, `stop`, `decline`, `schedule`, `cancel`, `assign`.
Staff see and act only on assigned recoveries within current scope. Native
sessions, assignment, grant, person, issuer and fallback authority are fenced
at reads and writes. Reassignment requires `assign`; company contact policies
and grant administration remain owner-only. Revocation confirms the shown
fallback, cancels waiting callbacks and retains the human state. A scheduled
sweep transfers work after other grant authority loss when that named fallback
is still current; if the fallback also lost authority, owner repair remains
required. Complete identity and deprovisioning remain HND-027 obligations.

Requested callback scheduling and waiting cancellation are available on the
recovery screen. A proposal sends nothing. Scheduling requires a caller request
and the HND-017 policy and recipient review; it does not establish carrier or
TCPA qualification. Human takeover, stop and decline cancel waiting callbacks;
already started calls remain observed, never falsely recalled. Staff attestations are visibly held until HND-017 supplies integrated effect-time consent, jurisdiction and USD budget qualification; they cannot create a provider call through the protocol-only owner path. Real receipt and the
integrated consent, jurisdiction and USD budget gate remain HND-017 gaps.

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
real carrier callback or handset receipt. A new business-hours unanswered call after a resolved or declined need creates a linked owned need. Unresolved work retains its owner, human state and due time, with each new missed call shown in its history. HND-047 retains accountable evidence and
HND-065 and HND-066 retain complete archive and erasure composition.

Task-intake boundary approved with riders by ct on 26 October 2026: exact-source weekly hours,
current owner approval and ownership, no automatic contact, and no automatic
reopening or reassignment of an existing human decision. This is additional to
the separately adopted caller-requested callback default. HND-017 stays PARTIAL.
