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
