# Cited follow-up review API

The native owner session can use `GET` and `POST /api/handset/followups`.
Creation selects an existing case and promise, transcript or disposition record,
quotes an obligation present in its text, and supplies `dueAt`,
`confirmationBasis`, a selected Orbit handoff `target` and an exact `draft`.
It returns a stable follow-up and replays the same source without a second one.
A changed replay conflicts. Sources remain native observations; this does not
establish recording consent or caller authentication.

`POST /api/handset/followups/{id}/{action}` requires the current `revision`.
Actions are `approve` (with `confirm: approve exact cited handoff`), `deliver`,
`reconcile`, `edit` (draft and dueAt), `cancel` and `decline` (with a note).
The named owner and current source/case revision are rechecked before a write.
Edits require fresh approval. Each mutation is audited and history is retained.
Cancellation never pretends that a started remote effect was recalled.

The only delivery here is an explicitly approved internal Orbit handoff through
its documented delegated `orbit.handoff.upsert` operation. A started write is
never blindly resent. Receipt readback proves delivery; current
`crm.handoff-state/1` readback separately proves open, completed or cancelled.
OAuth refusal, missing scope and unavailable readback leave the promise open
with a repair reason. Lists expose a bounded window and disclose truncation.
A verified inbound STOP on the correlated case cancels pending follow-up.

Customer SMS/email, automatic reminders, actual owning-system task creation,
consented transcript extraction and the review console are not implemented.
Orbit's task API and Pegboard's task API currently require native sessions;
the delegated Orbit handoff is not advertised as a task. HappyToHelp remains
a conversation-note handoff until a documented task mechanism is available.
No external browser session is copied to make these integrations work.
Owner-only administration and exact internal disclosure approval are the
conservative defaults pending a contract-policy ruling. HND-027 owns wider
role scope; HND-013/089 own capture and contact consent; HND-050 owns rules.
