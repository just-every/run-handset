# Capacity qualification

Handset distinguishes configured native admission from qualified hosted telephony.
An installation must not infer a carrier SLA or a live call capacity from a local
fixture, an emitted Dial instruction or a healthy HTTP endpoint.

## Native limits and admission

The owner configures each queue in Settings, under Queue setup. Its maximum
waiting setting bounds the combined waiting and reserved entries. Active calls
keep their occupied agent slots independently; this setting does not disconnect
an accepted call. Each agent has a separately configured concurrent assignment
capacity. Reservations across inbound queues and the outbound dialer occupy the
same agent slots.

The owner queue API at `/api/handset/queues` returns `capacity` for every queue:
`admissionLimit`, `pending`, `remaining` and the refusal reason. These are native
assignment counts, not measured media legs. A direct admission at capacity returns
HTTP 409 with `queue_capacity_exceeded` and the configured limit and occupied
count. Signed inbound voice receives a brief queue-full announcement and Hangup,
with no Dial or continuation loop. Existing entries and reservations are retained.
An already admitted caller can continue even when new admission is full.

Concurrent admission is checked within the transaction. Contended ingress retries
only optimistic native writes, at most eight attempts, rechecking source consent
and durable offer state each time. It never repeats an emitted Dial. A request
that cannot reconcile contention returns an explicit conflict rather than
inventing success. Provider readback failures retain their failure or uncertainty.

## Measured fixture bounds

The registered journey in `tests/handset-queues.mjs`, named “A 200-person roster
and 100 configured agents admit a concurrent twenty-call signed surge, refuse
saturation and retain unique reservations after restart”, uses the emitted Worker
and persistent local D1. People are seeded installation data; agent capabilities,
availability, memberships, exact routes and source consent use native HTTP doors.
Twilio request signatures and official Call resources are exercised at the network
edge. The fixture makes no live carrier call and creates no paid outbound API
request.

| Dimension | Qualified fixture |
| --- | --- |
| Active native people | 200, read back through the owner people door |
| Configured active agents | 100, each with one assignment slot and a current queue membership |
| Initial simultaneous inbound requests | 20 in one concurrent batch; 20 admitted with distinct call identities and agent slots |
| Pending admission limit | 20 waiting or reserved entries |
| Full admission | 20 additional concurrent requests refused, retaining every accepted entry, offer and reservation |
| Boundary with one connected call | One of 20 new requests admitted and 19 refused; the connected call keeps its slot |
| Restart retention | 21 occupied reservations and their source-bound offers retained; replay emits no duplicate Dial |

The journey emits measured setup, initial surge and saturated-refusal elapsed
milliseconds in its diagnostic receipt. An initial local observation configured
the roster in 9.3 seconds, reconciled the initial surge in 3.8 seconds and refused
the full batch in 0.6 seconds. These are fixture observations on one development
runtime, not deadlines, throughput guarantees or hosted capacity measurements.
The candidate's receipt supplies its own timings; machine scheduling and provider
latency can differ.

## Unqualified boundaries

Hosted-carrier capacity and availability remain unmeasured. This fixture does not
qualify 100 simultaneous connected calls, emergency or callback continuity under
load, message throughput, recording throughput, storage or archive limits. It
proves retained native reservations across a Worker restart, not the complete
region, carrier, gateway and Worker fault matrix at dial, connect and commit.

Complete installation archive restoration, later consent and custody retirement
fences, realistic retained-history recovery times and owner-visible recovery
objectives remain unfinished, including the Base-held HND-065 restore dependency.
An uncertain offer stays uncertain until authoritative provider readback. No
restoration or live-service claim follows from this bounded qualification.
