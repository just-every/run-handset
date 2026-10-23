# Continuity review API

A native owner calls `POST /api/handset/operations/assess` with a verified
`callRecordId`. The selected source must still be active. The implementation
reads Twilio Voice Insights' documented `/v1/Voice/{CallSid}/Summary` resource,
checks account/call identity and retains only bounded quality tags and summary
processing state. Numeric MOS/loss/jitter remain explicitly unqualified; API
success is never media-health proof. It correlates the same installation's
current Orbit metadata-access refusal, near-cap reserved USD budgets, pending
owned recovery cases and uncertain outcome steps.

The assessment is a cited proposal. A current owner records an exact approved
or declined decision at `/{id}/decision`, using the current revision, a note
and `confirm: record exact continuity decision`. The decision applies no fix
and grants no spend, live-route, promise, paging or publication authority.
`/{id}/export` emits bounded redacted JSON for a future Porthole receiver;
actual transfer/readback, independent Oncall paging and Lamp publication are
visibly pending. No general metrics/status product is built here.

Actual bidirectional call tests, numerical per-leg metrics, tested continuity
proposals, qualified fix execution and pending callback/CRM completion remain
HND-077 obligations. The schema source is Twilio's current public OpenAPI
`spec/json/twilio_insights_v1.json` (`insights.v1.call.summary`). Missing data is
unknown; a source permission is not an outbound or repair grant. Owner-only
review, no autonomous repair and no external publication are conservative
defaults pending ct.
