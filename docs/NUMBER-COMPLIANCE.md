# Number correction preparation

Native owners use `/api/handset/compliance` to prepare exact-number correction
cases for port PIN rejection, employee move, failed brand and toll-free verification
and observed reputation. Creation requires an active selected source, a bounded
strict report, named owner and due time and `confirm: prepare exact compliance case`.
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
date; PINs and raw business contacts and addresses are discarded. A carrier date or
registration status never proves voice and SMS readiness or a clean network label.
Cases keep their named owner and due time. Other provider, network and employee
readbacks remain visibly held.

Current schema references: Twilio's public `twilio-oai` Numbers v1 and Messaging
v1 OpenAPI resources. Actual personally attested filings and signed LOAs,
qualified E911 changes, approved rotation and independent network observations
remain HND-002, HND-004, HND-005, HND-012, HND-031 and HND-075 obligations. RL-110 permits current-owner preparation and accountable follow-up. Preparation
confers no legal attestation, E911 confirmation, number or spending authority
and no live carrier qualification.


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


## Native correction console

Open **Settings → Number compliance** at `/app/compliance`. The list retains
unresolved cases in due order. An empty list opens the preparation choices.
Choose a case type to prepare a port PIN rejection, employee move, failed brand
or toll-free verification, or receiving-network reputation observation. Forms
select a currently authorized business-number source and collect only the
report fields that case needs. There is no PIN field or generic report upload.
Employee move and network observation forms cite existing native records;
preparation does not certify their facts.

Each detail shows the selected number, source account and revision, source
authority, reported resource identity, named owner, UTC due time, actionable
corrections and independent readback uncertainty. **Review prepared corrections**
retains the current named owner's preparation note. It is visibly separate from
the named person's own legal attestation, signed LOA, location confirmation and
any exact effect approval. **Continue named follow-up** assigns a current active
owner, future UTC due time and next action, retaining the former due time and
owner in review history. Validation and stale-revision refusals preserve entered
corrections; a stale form must be reviewed and confirmed again.

**Provider receipt and submission hold** reads only the exact selected receipt
when explicitly confirmed. An unavailable or mismatched receipt retains the
last observation and named due work. Employee and per-network readback remains
held. **Check submission hold** records the existing held outcome; it makes no
provider mutation. No number move, active emergency-address change, replacement
purchase, rotation, spend or third-party Free Caller Registry filing is enabled.
Provider approval never closes the case or establishes voice or SMS readiness
or a clean network reputation. Non-owners cannot read cases or use their forms.
A revoked source stops subsequent preparation, review and provider readback;
retained history conveys no new source authority.

The registered **compliance console at 1440** and **compliance console at 390**
journeys in `tests/handset-console-browser.mjs` exercise these native screens
using `tests/helpers/handset-compliance-browser.mjs`. Official-schema provider
readbacks are faked only at the network edge. Provider readback qualification
and named approvals remain: personally attested permitted filings, real signed
LOA, carrier correction submission and readback, employee and E911 confirmation,
independent per-network reputation proof, qualified FOC and approval follow-through
are unproved. HND-002, HND-004, HND-005, HND-012 and HND-031 retain their foundations.
