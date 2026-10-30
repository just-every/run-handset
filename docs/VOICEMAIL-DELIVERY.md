# Reviewed voicemail email delivery

The current owner of an exact native mailbox chooses a current native recipient
and one of three modes under that mailbox’s **Delivery settings**:

- Audio attachment plus supplied text.
- Supplied text only, without fetching recording bytes.
- An expiring authenticated link, without an attachment or text copy.

Nothing sends by default. The settings show the current choices, selected
recipient and custody notice before saving. Email recipients may retain or
forward copies. Later local erasure or revocation cannot recall bytes already
received. Changing the mailbox membership, recipient identity, selected mode or
required policy invalidates pending work and existing links until fresh review.

A mailbox owner can require authenticated links only. That policy prohibits both
attachments and plain text copies. This native restriction does not establish
clinical processor, agreement, consented capture or legal qualification.

Supplied observations are not recordings or qualified transcriptions. To send
content, create the observation with the exact native recording ID as its source
reference, then bind the separately approved recording and matching supplied
transcript from the item’s **Bind approved content** form. The recording must
come from the current signed provider source. Both the mailbox owner and the
recipient need independent current grants for supplied text, and also recording
playback for attachment or link mode. Mailbox access alone grants neither.

**Queue reviewed delivery** selects an enabled recipient and mode and an explicit
UTC due time. The scheduler atomically claims one job and checks the native
people, exact mailbox, source, content grants, recipient email and saved settings
again after retrieving any recording bytes, immediately before requesting mail.
A missing or changed permission suppresses release. No unavailable content is
silently omitted or substituted. The native item, recording and source identities
and supplied-text provenance accompany released text copies.

Provider acceptance is separate from inbox delivery. An uncertain response stays
uncertain and is never automatically sent again. Restart and scheduler replay
cannot duplicate an attempted copy. A preparation interrupted by a crash stays
held. A new explicitly reviewed setting revision can authorize a new attempt;
the operator must resolve an uncertain earlier attempt before doing so.

Authenticated links require a native session for the exact recipient. Each text
and audio request checks link expiry and revocation, mailbox membership, source,
saved settings and independent underlying content grants. A link is never a
bearer grant. The mailbox owner can revoke it in Delivery settings. Maximum link
lifetime is one hour; earlier content-grant expiry also stops access. Neither
link revocation nor any other action recalls bytes a recipient already obtained.

Native protocol-edge journeys qualify these local controls. Real controlled-inbox
receipts, carrier voicemail capture, speech accuracy and timing, clinical
processors and installation-wide retention and erasure remain contract gaps.
