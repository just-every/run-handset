# Virtual hold and callbacks

HND-017 remains partial. Current owners manage callbacks at `/app/callbacks`; the
API is `/api/handset/callbacks`.

## Policy (owner-approved, off by default)

Nothing is offered or dialed until a current owner approves a callback policy for
one business number: its queue, the staff number that rings when the customer
answers, the business name spoken to callers, an attempt limit (one to three) and
a retry delay. Approval needs `approve caller-requested callbacks` and is checked
again against the owner's current authority at every claim. A change revokes
nothing already dialed.

## Virtual hold

With a policy, a caller waiting in that queue hears the offer: press 1 to keep the
place and receive a call back at the number they are calling from. The key press
is a signed carrier request bound to that queued call, which is read back from the
carrier and must still be up. Pressing 1 leaves the line, ends the queue entry as a
virtual hold and records a callback that keeps the entry's exact arrival time and
priority. The recorded consent names the time, caller, called number, key, call,
exact prompt version, purpose and legal basis, and marks no marketing enrollment.
An owned missed-call recovery is created or reused for the same case. A replayed
key press adds nothing.

## Dialing

The scheduler dials the earliest retained place first, one attempt per callback and
one callback per free agent. A call is placed only when all of these hold: the
source, policy and owner are current; the recovery is still open; no voice STOP or
DNC applies; the owner-reviewed recipient timezone and local hours (shared with the
text-back gates) allow it; and a logged-in available agent exists beyond the live
callers waiting. Held reasons are kept on the callback.

The attempt is claimed durably before any network request. A rejected create is a
failed attempt. A lost or unreadable create response is **uncertain**: it is never
retried by a restart or a tick, and only the owner can resolve it as not placed
(eligible again) or placed. After a restart, a claim without a provider call is
marked uncertain and an open attempt is settled from the carrier's own call
resource, never by dialing again.

## Outcomes

The customer hears the business name and presses 1 to speak with staff now, or 2 if
a callback is no longer needed. Only the staff leg, read back from the carrier with
the exact parent, destination and a duration of at least one second, completes the
callback and resolves the missed call. A decline closes the callback and the
recovery. Busy, no answer, no key press or an unreachable staff leg is still open:
the callback retries in its retained place after the delay, and after the attempt
limit it stays an owned open task. Owners can cancel with a documented reason.

## Owner-scheduled callbacks

An owner can schedule a callback for an open recovery by attesting
`the customer asked for this callback` with evidence. It dials under exactly the
same gates. Nothing contacts a customer who has not asked.

## What is not proved here

Real carrier callbacks to real receivers, the toll-free verified text receipt for
the same call, and personal ring rules (HND-078) for the staff leg need a carrier
and receivers. HND-089 keeps the in-call text consent; this slice records its own
callback consent and never infers one from the other.
