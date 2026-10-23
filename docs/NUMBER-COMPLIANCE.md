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
