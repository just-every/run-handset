# Call text consent and customer feedback

The owner reviews the exact business, toll-free verification, legal configuration,
staff number and expiry at `/app/consent`. This is separate authority from inbound
source records. Approval is installation-local, expires within one day and is
rechecked against current native ownership and source revision. It cannot enroll
anyone in marketing. The native API is `/api/handset/consent`.

The source's voice webhook is the displayed consent provider path. A signed,
independently read-back inbound call hears a version-pinned optional keypad prompt
before the approved staff number rings. Pressing 1 grants one customer-care reply;
a decline or timeout runs identical staff ringing instructions. No conversation
recording is started. The native consent API retains the exact prompt, provider
call and leg, observed caller and called number, DTMF, server time, purpose, scope
and reviewed legal basis. Calling alone grants no permission.

The Dial action independently reads the exact parent and staff child. A missed
child creates one owned callback in the existing recovery console. A granted
permission queues one reply, with a hard deadline of 60 seconds after the provider
missed timestamp. Immediately before submission the adapter checks number
confidence, company-wide SMS STOP and DNC, current owner-reviewed recipient
IANA timezone and local hours, source and policy authority, and an independently
read-back `TWILIO_APPROVED` toll-free verification for that exact business number.
Unknown identity or timezone, quiet hours, or pending verification suppresses the
reply and retains the task. Current source consent alone never permits a send.

Configure the business number's terminal call-status callback to the existing
signed `/providers/twilio/events` source door as well as its voice webhook.
When a caller hangs up inside the consent prompt, no staff Dial action exists.
That terminal callback independently reads the ended inbound parent and the
complete, empty child-call list before recording no response and one owned task.
Incomplete child readback or withdrawn policy authority refuses this intake.
An existing staff child stays with its separate Dial outcome. A restart or a
replayed terminal callback keeps the original task; this path cannot grant text
permission.

Message creation is claimed durably before the network request. An independently
read-back first submission consumes the permission; accepted is distinct from
delivered. A lost response remains uncertain and cannot retry automatically.
DTMF, missed status and delivery callback replays reuse the original permission,
task and message. A pending permission cannot authorize a campaign or survey.

A human owner can attest equivalent verbal permission through the verbal consent
API only with a same-call permitted transcript moment. A separate prior
participant-recording-permission attestation, current native owner authority and
that person's current transcript access are required. This attestation records
what the human verified; it does not qualify otherwise unconsented capture or
speech accuracy. A model bearer credential cannot reach this door. HND-013 retains
capture qualification and HND-105 retains broader receptionist role scope.

At `/app/surveys`, the owner approves one optional invitation for an actual call.
A completed, independently read-back staff conversation returns to the existing
caller leg for the optional survey prompt. Survey permission is separate from the
missed-call reply: press 1 for the declared 1-to-5 IVR rating or one survey text,
or decline without a rating. SMS replies arrive through the business number's
existing signed event webhook. Ambiguous outstanding invitations cannot acquire a
rating. Both directions have independent provider identity readback.

The first valid response per invitation is retained without overwriting it on a
replay or later reply. SMS may include an optional comment. Invitations expire
without a rating after seven days. The report exposes invitation count, eligible
delivered count, actual response count, response rate using eligible delivery,
mean using actual responses, declined, suppressed, pending and no-response states.
SMS is eligible only after independently confirmed delivery; opted-in IVR is
eligible when the rating prompt is served. Model sentiment annotations and agent
QA never enter the rating table. Survey handling changes no call outcome, staff
status, public statement or remedial promise.

HND-011, HND-012, HND-017, HND-022, HND-030 and HND-097 inherit current purpose,
STOP, registration, recipient hours and source fences at their future outbound
text doors. HND-047 inherits the retained consent and delivery audit vocabulary;
HND-065 and HND-066 retain complete portability and erasure composition.

Proof lives in `tests/handset-recovery.mjs` and
`tests/handset-receptionist-browser.mjs`, with the browser workflows at 1440 and
390. The committed `tests/journeys/handset-consent-timing.mjs` runs separately
through the heavy slot on the exact candidate. The official Twilio network edge
is substituted in these tests. It is not a physical handset receipt. Run Edit Run's
toll-free verification is IN REVIEW; real SMS sending and handset receipt remain
unqualified until that approval is available. No A2P 10DLC registration is assumed.

Provider schemas: [Gather](https://www.twilio.com/docs/voice/twiml/gather),
[Calls](https://www.twilio.com/docs/voice/api/call-resource),
[Messages](https://www.twilio.com/docs/messaging/api/message-resource), and
[toll-free verification](https://www.twilio.com/docs/messaging/api/tollfree-verification-resource).
