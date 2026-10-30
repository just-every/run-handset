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
stable operation keys and local keys support the documented replay contract. Dial's
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

Inbox messages retain their durable job identity, submission time, independent
readback time, provider acceptance and carrier delivery separately in the delivery
inventory. Their status callback is bound to that exact job. After a lost create
response, a signed callback can recover the provider identity by reading the
message from the selected account. Unsigned callbacks, foreign parties,
conflicting callback replays, reused provider identities, different content and
receipts older than submission are refused. Restart never queues a started send
again; interrupted claims become visible uncertainty after one minute.

If the callback was also lost, a current native owner may use
`POST /api/handset/messages/jobs/{id}/reconcile` with the current `revision`, the
independently inspected `providerSid` and `confirm` set to
`read back this submitted message`. This operation reads the receiver only.
It verifies the exact account, parties, content, media count and submission time
before binding the receipt, and retains the owner attribution in audit. A source
revocation during readback refuses the commit. Older jobs with no known provider
identity or submission time remain uncertain for human investigation. No repair
operation creates a message or grants sending permission.

The connection inventory reads the current owner-selected service, opportunity
and conversation mappings, current source authority and observed receiver
results. Successful readback time and oldest unresolved work age are distinct
from remote health. Knowledge sources show exact source references, revisions,
cache age and unavailable authority; archive destinations show selected folder,
custody and transfer state. Message, call-bound text, model and notice projections
omit bodies, credentials and recipients. Each list advertises its bound and
links to the existing domain repair door.

A receptionist attempt also retains its receiving origin. Reconfiguring the
connector cannot redirect a previously started operation or even its readback
correlation to a replacement receiver. Restore the original configuration to
reconcile it. Historical attempts without a recorded origin remain held for
human investigation. A matching booking slot alone is insufficient: the caller,
service and call correlation must match. CRM confirmation requires the exact
operation receipt and selected target as well as the handoff content; a
conflicting existing receipt stays uncertain without another write.

Call-bound customer-care and survey texts use the same signed-receipt boundary.
The native `POST /api/handset/consent/reconcile` door accepts `textId`, the
independently inspected `providerSid` and the same explicit readback confirmation.
It preserves the named owner in audit. Neither it nor a signed status callback
resends a text. Exact account, parties, content, submission time and a unique
provider identity must match; conflicting signed payloads are refused and a
late status cannot undo terminal delivery. Expired scope remains visible through
restart. Revocation during the readback prevents confirmation. A historical
unknown identity without its original submission time requires investigation.

Qualification remains bounded to these current native doors and official-schema
receiver edges. It does not prove physical handset receipt or a real tenant.
The existing owner-only repair visibility default still awaits ct approval.
SMS spending-budget exhaustion and qualified customer-email consent, version
and budget races remain unproved under D-3. Future connectors inherit the same
final authority barrier, current scope visibility and uncertain-effect rules;
the current inventory does not certify an adapter that does not yet exist.
