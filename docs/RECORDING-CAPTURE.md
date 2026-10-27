# Recording capture controls

The recording console links to `/app/recordings/capture`. Current native owners
review an exact signed-source call, every named participant and the all-party
policy. An unknown jurisdiction or any refusal blocks start. Area codes never
supply jurisdiction. These controls do not play an announcement: a human must
attest that the recording and AI disclosure finished for this participant set.
That attestation is revision-bound and remains unqualified live-call evidence.

Start, pause, resume and stop use the official
[Twilio recording resource](https://www.twilio.com/docs/voice/api/recording).
Each explicit mutation checks native owner authority, current source, exact call
readback and the submitted revision. Before each provider write the operation
becomes uncertain, blocking media release. Unconfirmed writes are never replayed.
Pause requests `PauseBehavior=skip`; resume needs another announcement boundary.
A participant change closes content access before a stop request. It permanently
withholds that recording even if participants are subsequently re-approved.
A failed stop remains blocked and requires carrier-side investigation.

The only destination is the installation's privately bound Twilio account at
`https://api.twilio.com`. Requests send the exact call and recording references,
capture controls, recording channel and track choices, and the existing signed
recording-status callback address. The purpose is the owner's explicitly
approved capture operation. No audio or transcript is sent to a model or a new
destination. Native authority and source consent are checked again after call
readback and before the provider mutation; completion rechecks them. If start
or resume completes after authority changes, the control attempts an exact
recording stop and keeps downstream content withheld. This is not proof that
an already in-flight remote action can be recalled.

Playback still needs its existing current exact-person grant and provider
identity readback. Transcript authority is independent. Controlled recordings
are withheld from both paths, archive content and quality review while capture
is active, paused, blocked, uncertain, erasing or erased. A reviewed retention
end also withholds content after that instant. Legacy recordings without a
capture session retain their separate owner-attested grants. No public media
URL or direct object download is added.

Retention has no implicit age pruning. An owner explicitly saves a retention
end or no scheduled end and a legal hold. A hold prevents erasure. After a
reviewed end, an owner must explicitly confirm exact erasure against the current
revision; no background deletion occurs. Provider deletion acknowledgment then
clears the native supplied transcript, its corrections and annotations and
revokes its playback and text grants, retaining opaque audit boundaries.
Unconfirmed deletion remains erasing and content stays withheld. This covers
one provider resource and these native tables; it does not certify provider
backups, installation archives, previously downloaded copies or every derived
store. HND-065 and HND-066 retain that installation-wide work.

Default ADOPTED pending ct: owner-only capture control; explicit all-party
participant review and human announcement attestation; unknown context denied;
no automatic resume, uncertain replay or deletion. Broader number, user and
queue administration remains HND-013 and HND-027's original target. The audible
California call, automatic live participant detection and interval exclusion
from real audio, live models, streams and downstream copies remain unproved.
These native transitions do not certify capture consent or payment compliance.
