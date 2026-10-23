# Tested follow-up rules

Owners use `POST /api/handset/rules/preview` with a strict `definition` and an
existing `sampleRecordId`. Supported triggers are `missed_call`, `disposition`
and `callback_due`. A real matching record is required; the preview shows the
exact action/message and sends nothing. The ten-minute preview belongs to the
current native owner and can be consumed once by `/publish` with
`confirm: publish exact tested rule`. Editing uses ruleId and expectedRevision
in a fresh preview; old queued revisions are invalidated. `/pause` cancels
queued work immediately. `/events` explicitly submits a matching native record;
signed missed-call events and due callback records also enter through the Worker.

The definition includes name, trigger, action, exact message, delayMinutes,
timezone, startMinute and endMinute. Actions `internal` and `owner_email`
record owned next steps or send an explicitly approved notice only to the
installation owner's current mailbox. Rules cannot select a customer email or
an arbitrary sender. Quiet hours delay the notice. SMS, Crank and Zapier actions
are visibly held until their actual authorized adapters and readback exist.

The outbox binds each run to its source record, case version, rule revision and
owner version. Current stops cancel queued contact. Each source/action/owner
can produce at most one run even across competing rules; outputs are not input
events. Claims commit before a send. A lost response or interrupted claim stays
uncertain and is never blindly retried. Each publication is capped at 100
started notices. Delivery acceptance and promised-work status are distinct;
work remains open after every reminder. `GET /api/handset/rules` exposes bounded
rules and run history, current reasons and the owned next due time.

Provider inbox readback, customer sending policy, monetary cost qualification
and Crank and Zapier receiver qualification remain pending. This is
an internal-reminder slice. Owner-only administration and explicitly approved
notices to the installation owner's mailbox, with no automatic customer
contact, are conservative defaults pending ct. HND-050 retains the full rule
and receiving-system acceptance; HND-036 inherits delivery repair and future
adapters, HND-011/089 consent and HND-028 provider cost accounting.

Native owners open `/app/rules` to preview each trigger against a matching
source record, inspect the exact action, message and recipient, and approve
the single-use preview. Published rules expose revision, owner and pause;
revisions require a fresh tested preview. Run history distinguishes delivery
state from open work and shows the next due time and cancellation reason.
Allowed notice times are minute offsets in the selected local timezone.
The view discloses its 100-rule and 200-run limits.
