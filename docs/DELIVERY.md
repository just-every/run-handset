# Connector delivery and repair

`GET /api/handset/delivery` is a read-only native-owner inventory. It shows
current connector scope and mapped categories, bounded source receipts and
observed lag, unresolved parent events, outcome steps, follow-ups, rule runs,
uncertainty and repair routes. Limits are explicit; receipt age does not claim
remote service health. No connector token or raw provider payload is exported.

Signed Twilio ingress retains event identity, payload hash, source and receipt
times and canonical call and case correlations. Duplicates replay receipts;
conflicting, foreign and forged events refuse. Out-of-order dependent events
remain held for their parent. Status observations are retained facts, never a
claim that a customer need is completed. Provider-specific call-control doors
continue using their independent current-resource readbacks.

Existing receptionist booking, deposit, refund and CRM and support handoff writes
now pin the originating case version and current limits policy. Their durable
step claims and the last barrier before every provider POST recheck current
grant, owner, case, policy, STOP and reserved budget. The barrier runs after
remote preflight; a change during that wait prevents the POST. Caller charge
authorization expiry and the named refund approver's current authority are
also rechecked. Historical outcomes with no case snapshot retain readable
receipts but cannot initiate more effects. A support handoff writes only to an
existing helpdesk conversation that the owner's limits policy maps to the
call's case (`supportConversations`); any other conversation is refused before
the installation helpdesk credential is used.

Orbit and HappyToHelp first inspect the existing remote handoff or note. Their
stable operation/local keys support the documented replay contract. Dial's
native creation key recovers its existing creation attempt. Stripe retries
retain the original key and stop before 23 hours, ahead of its 24-hour key
pruning boundary; an older uncertain charge or refund needs readback or human
repair. Expired OAuth and missing scope remain explicit refusal and repair states.
No new idempotency key is minted to hide uncertainty.

The inventory retains each receiving-system attempt's reason through restart,
including refused credentials and removed target scope. A refused later read
cannot establish that an earlier lost write failed: the attempt stays uncertain
and retains its reservation until readback settles it. Once access returns,
reconciliation uses the original operation key and reads the existing effect
without another write. Historical rows without recorded reasons explicitly say
that their reason is unavailable. Rotating an application secret also fences
an in-flight preflight before its provider write.

This does not qualify the receiving accounts, delegated Dial booking,
customer SMS and email or every future connector. Complete current state and lag
coverage for those systems, scope-change callbacks, qualified provider receipts
and full repair controls across every connector remain HND-036 work. The existing caller-outcomes console shows persisted step reasons, including refused credentials and confirmed readback. Existing HND-071 and future
HND-030, HND-037 through HND-041, HND-044, HND-050, HND-072 and HND-073 effects inherit these barriers. The source
consent and customer identity gaps of HND-013, HND-018 and HND-089 still apply.

The inventory also lists each current receptionist policy's exact booking,
payment, CRM and support mappings and mapped field categories. Configuration is
reported separately from authorization: an installed credential or a historical
success is not a current remote scope check. Current receiver delivery lag remains unknown until an exact receiving readback;
a historical step success alone cannot supply it. Aggregate confirmed, rejected, held and uncertain counts include the full
native step history; the detailed step list remains bounded to 200 rows. Selected
inbound sources show active, suspended or revoked current native authority,
latest observed event delay and the oldest unresolved parent age. Current
reviewed-message jobs include their source, thread, receiving identity and
provider versus carrier state, without message content or permission evidence.

When creation returns a booking, payment or refund identity but its readback
fails, that identity is retained. Reconciliation then reads that exact remote
record without another creation POST, including after the payment key's replay
window closes. Credential refusal, removed read scope and a record that does not
match the original call or outcome remain uncertain; they cannot release a
possibly committed deposit reservation or confirm a different effect. Restored
access confirms the original effect. CRM and support read-scope refusal halts
reconciliation before a write, even if another endpoint still accepts writes.
Each listed step explains whether repair starts with readback, permits only its
original key under the receiver contract, or requires human resolution. The
inventory itself grants no new authority and performs no network effects.

Reviewed customer-care messages recheck STOP, explicit permission, current
consent policy, thread custody, selected source and recipient hours after
provider registration preflight. The registered transport journey changes each
of those gates while preflight is in flight, then restarts the Worker and checks
that the suppressed job never reaches the receiving message endpoint. This is
network-edge qualification, not a receipt from an independent physical handset.

An owner may explicitly refresh current read-scope observations with
`POST /api/handset/delivery/inspect`, using `connector`, the current
`mappingVersion`, and `confirm: "inspect current connector read scope"`.
The supported connector values are `dial`, `stripe`, `orbit` and `helpdesk`.
Inspection derives its destinations exclusively from current native mappings;
it accepts no URL or credential. It reads at most ten mapped targets per page.
Continue with the returned `nextCursor` under the same mapping version. A
changed policy refuses an old review before any receiving request.

Orbit inspects the selected delegated target, and support inspects each selected
existing conversation. Booking and payment inspection read an already known
receiving identity under the current policy. Without one, their read scope is
explicitly not checked; inspection never creates a record to discover it.
Observations retain failed reads and the last successful check through restart.
The inventory marks an earlier mapping version stale and exposes observation
age. These are read-scope observations, not write grants, OAuth lifecycle
callbacks or a guarantee of remote service health. Delivery is checked separately
against an exact known effect at that same current connection.

A recorded credential or selected-scope refusal fences every later dependent
creation POST, even if a different remote endpoint is still writable. An owner
must explicitly inspect restored read access before new writes can proceed.
Known-effect readback can still reconcile the original effect without a write.
Every inspection rechecks the current native owner and mapping before each
remote read and again before saving or returning its observations. No remote
payload, caller content or credential enters the retained check records.

A read-scope refusal before the first CRM or support write is a definitive
rejection: no effect was attempted. If creation may already have committed,
a refused read remains uncertain. Receiving access can then be restored and
the original effect read back without another write. Reporting retains this
distinction between rejected work and possibly committed work.


Current receiver delivery and observed lag

An explicit inspection also reads the most recent known effect for each selected
target: Dial's exact booking, Stripe's exact payment or refund, Orbit's stable
operation, or HappyToHelp's stable local message in the selected conversation.
Scope success alone cannot confirm delivery. Identity, content and effect state
must match; absent, refused, mismatched, ambiguous or incomplete readback leaves
delivery pending. No inspection creates or replays an effect, changes its native
step state, or grants authority to repair it.

The endpoint and credential together identify a receiving connection privately.
A change to either invalidates earlier observations even under an unchanged
mapping version. The equality key, credential and receiving payload are never
returned by the inventory. An earlier connector's success cannot prove that its
replacement has received a message. When the replacement lags, inspection reads
the original stable identity there until the matching message is available;
it never sends a second message to make the read pass.

Each inspection exposes `delivery.state`, `stepId`, `startedAt`, `confirmedAt`,
`lagMs` and `pendingAgeMs`. Connector `remoteLagMs` and `lastCurrentDeliveryAt`
use only a non-stale, matching receipt at the current receiver. Lag measures the
initial local effect claim through the first exact receiving readback, an observed
upper bound including preflight, transport, receiver delay and inspection delay.
Later inspections and restarts retain that first receipt. Pending age increases
until a matching read; uninspected effects have unknown delivery and lag. The
existing `lastSuccessfulAt` remains historical native step success and is distinct
from `lastCurrentDeliveryAt`. These are bounded observations, not service health,
a processing-time SLA or a customer read receipt. Repair inventory and inspection
remain native-owner-only.

`tests/handset-transports.mjs` — “Current receiving connector receipts a delayed
earlier support message with its own lag through restart” proves endpoint
replacement and credential-only renewal against an independent HappyToHelp API
edge. It sends once through the earlier connection, observes the current receiver
empty at 45 seconds, then reads the same message there at 90 seconds and retains
that receipt after restart. Foreign content, duplicate identities, unread pages,
removed scope and non-owner access cannot manufacture delivery. No real receiving
account or physical handset is qualified by this edge proof.
