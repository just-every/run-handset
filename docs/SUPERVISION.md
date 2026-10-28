# Native supervision

Open **Settings → Supervision**. The owner issues supervision permissions for
an exact active person and queue, with a separate agent-state capability and
an explicit expiry within one day. Ownership itself grants no wallboard read.
The issuing owner's and recipient's current native identity versions, session,
expiry and revocation are checked at every door. HND-105 retains broader role
administration and scoped delegation.

Each permitted queue has a supervisor view and a TV view. Both refresh every
three seconds and hide caller identity, phone numbers and call content. A
service-level breach means a waiting native entry or a reviewed answered or
eligible abandoned entry exceeded the configured answer target. The views
separately label current waiting breaches and reviewed interval breaches.
Reviewed queue measures use HND-086's formula implementation and configuration;
native current calls and supplied historical observations are labeled separately.
Agent duration measures describe the supplied agent timeline, not independent
staff audio or a claim that all staffed time belonged to one queue.

Interrupted reads retain the last displayed values and mark them stale. Agent
interventions are disabled during loss. A refused current authority check clears
the display and removes controls. No metric snapshot is persisted in a second
store, so an erased import cannot be recovered from a supervision cache.

An authorized intervention changes available to unavailable (`away`) or back.
It retains actor, time, reason and both states in an append-only timeline and
uses the queue dispatcher's existing availability field. It does not refresh an
agent's heartbeat or change queue login, wrap-up, reservations or active calls.
Because that field affects every queue membership, the supervisor needs current
intervention grants for every queue the agent belongs to. Agents retain their
independent queue self-service door.

The native scope and shared-agent boundary are conservative interim defaults
under the standing 27 October policy. They do not qualify listen, private
whisper, audible barge or takeover. Direct foreign-team call control is refused
before any provider attempt; an in-scope request remains visibly held for media
qualification. Controlled agent and independent caller audio, applicable consent
and their audit qualification remain HND-019 work. Routed long-wait and
abandonment-spike alert delivery also remains unproved.

The API journey is `tests/handset-supervision.mjs`. Official Twilio schema-edge
active-call preservation and refusal are composed into `tests/handset-queues.mjs`.
The supervisor and TV screen journey is registered in
`tests/handset-console-browser.mjs` at 1440 and 390. Its breach visibility
measurement uses the browser's elapsed clock. It checks both a reviewed threshold
change and a native waiting call crossing an unchanged answer target, advancing
only the isolated Worker clock for the latter. It reconciles displayed source
legs, every queue total, agent durations, offers, staffing and occupancy against
the known dataset. Interrupted update transport retains those queue and agent
values on the supervisor and TV views; subsequent revocation clears access.
