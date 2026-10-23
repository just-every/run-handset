# Connector delivery and repair

`GET /api/handset/delivery` is a read-only native-owner inventory. It shows
current connector scope and mapped categories, bounded source receipts and
observed lag, unresolved parent events, outcome steps, follow-ups, rule runs,
uncertainty and repair routes. Limits are explicit; receipt age does not claim
remote service health. No connector token or raw provider payload is exported.

Signed Twilio ingress retains event identity, payload hash, original/receipt
times and canonical call/case correlations. Duplicates replay receipts;
conflicting, foreign and forged events refuse. Out-of-order dependent events
remain held for their parent. Status observations are retained facts, never a
claim that a customer need is completed. Provider-specific call-control doors
continue using their independent current-resource readbacks.

Existing receptionist booking, deposit, refund and CRM/support handoff writes
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

Orbit and HappyToHelp first inspect the existing remote handoff/note. Their
stable operation/local keys support the documented replay contract. Dial's
native creation key recovers its existing creation attempt. Stripe retries
retain the original key and stop before 23 hours, ahead of its 24-hour key
pruning boundary; an older uncertain charge/refund needs readback or human
repair. Expired OAuth and missing scope remain explicit refusal/repair states.
No new idempotency key is minted to hide uncertainty.

This does not qualify the receiving accounts, delegated Dial booking,
customer SMS/email or every future connector. Complete current-state/lag
coverage for those systems, scope-change callbacks, qualified provider receipts
and a repair console remain HND-036 work. Existing HND-071 and future
HND-030/037–041/044/050/072/073 effects inherit these barriers. The source
consent and customer identity gaps of HND-013/018/089 still apply.
