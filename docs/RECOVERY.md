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
consent capture, reply routing, dynamic need splitting or the recovery console.
Actual contact must use HND-011/017/031/089 and the existing dialer approval,
licensed-registry, local-time and budget controls; no source permission supplies
outbound authority. Native-owner-only management, no autonomous contact and
explicit human decline evidence are conservative defaults pending ct.
