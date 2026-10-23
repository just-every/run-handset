# Number correction preparation

Native owners use `/api/handset/compliance` to prepare exact-number correction
cases for port PIN rejection, employee move, failed brand/toll-free verification
and observed reputation. Creation requires an active selected source, a bounded
strict report, named owner/due time and `confirm: prepare exact compliance case`.
Port reports accept Twilio PortInPhoneNumber status/rejection categories, never
a PIN. Brand and toll-free reports accept the current public Twilio Messaging
resource fields; move notices and reputation observations cite native records.
Owner-supplied reports are explicitly unverified until independent readback.

`/{id}/review` records exact preparation review, not a legal attestation or
permission to move a number. `/{id}/submit` stays held without qualified filing,
LOA, validated location, rotation and spend adapters. The API never buys or
rotates a number, changes an active emergency address or submits a Free Caller
Registry entry. The business representative must submit that registry directly.

With exact native owner confirmation, `/{id}/readback` can read the selected
Twilio Numbers port-phone resource or Messaging toll-free verification.
The returned phone must match the selected source number, and an account field
must match when present. Readbacks retain only status, observed time and port
date; PINs and raw business contacts/addresses are discarded. A carrier date or
registration status never proves voice/SMS readiness or a clean network label.
Cases keep their named owner and due time. Other provider/network and employee
readbacks remain visibly held.

Current schema references: Twilio's public `twilio-oai` Numbers v1 and Messaging
v1 OpenAPI resources. Actual personally attested filings and signed LOAs,
qualified E911 changes, approved rotation and independent network observations
remain HND-002/004/005/012/031/075 obligations. Owner-only preparation and no
automatic legal, address, number or spend change are conservative defaults
pending ct; they confer no live carrier qualification.


## Receipt identity and continued follow-up

Port preparation accepts the official `phone_number_sid` field. The earlier
`port_in_phone_number_sid` spelling remains accepted alone for existing clients;
supplying both is rejected as ambiguous. Readback must match the selected account,
phone number, port request and phone resource. Toll-free readback must also match
the exact verification ID. Brand readback uses the Twilio Messaging brand resource
and checks the account and brand ID; an approved brand never implies campaign
approval, number eligibility or message readiness.

The safe receipt keeps state, observation time, the exact resource ID and numeric
rejection category. Raw business contacts, free-form provider facts and PINs are
not retained. A mismatched or unavailable receipt leaves the existing case due.

`POST /api/handset/compliance/:id/follow-up` requires the current `revision`,
a named active owner in `ownerId`, future `dueAt`, `nextAction` and
`confirm: "assign exact continued follow-up"`. It retains the previous assignee
and due time in append-only history, changes the next follow-up atomically, and
refuses a stale review. It never closes a compliance case or grants legal,
location, number or spending authority. `GET /api/handset/compliance/:id` returns
the retained preparation, named reviews, provider observations and follow-up
history to the native owner. No notification or provider mutation is sent.
