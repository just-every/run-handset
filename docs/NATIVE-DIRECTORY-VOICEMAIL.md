# Native directory and voicemail preparation

These authenticated JSON doors prepare native records. They do not import a
source directory, synchronize a tenant, authenticate a caller, capture audio,
transcribe speech or send email. Both clauses remain partial.

Use the existing native session and same-origin POST rules. Every response is
noncacheable. Writes and reads repeat current session authority in the audited
transaction. Company management and shared-box creation remain owner-only while
HND-027 supplies the separately scoped capabilities specified by ct.

## Directory

POST `/api/handset/directory/contacts` with name, number, visibility (`personal`
or `company`), optional timezone, suppressed and held flags (zero or one), and
source identity strings. Personal contacts belong only to their creating person.
An explicit international calling code is required; formatting and an extension
introduced by x, ext or # are separated. This is syntax normalization, not full
regional number validation. Unknown timezone remains null.

GET `/api/handset/directory/contacts` or append a contact ID. GET
`/api/handset/directory/match?number=...` returns only a unique authorized match;
an ambiguous or unknown result discloses no contact. A match never authenticates
anyone. GET `/api/handset/directory/export` returns native JSON, not a portable
CSV or vCard import format.

POST to a contact ID with revision and the changed name, number or timezone to
edit it. An edit preserves suppression, holds and source identities, and
withdraws existing read grants. Personal edits remain private to that person.

POST to a contact's grant or revoke suffix with revision and personId. Company
member reads require this explicit grant. Issuer and recipient version changes
invalidate it. GET `/api/handset/directory/grants` lets a current native owner
inspect the retained grants. A merge removes both records' grants from this
list. Personal contacts cannot be granted to anyone else.

POST to a contact's merge suffix with revision, otherId, otherRevision and
confirm equal to `merge these exact contacts and withdraw read grants`. The
selected destination keeps its name and number; suppression and holds combine
conservatively and source IDs are retained. Both contacts' read grants are
withdrawn atomically. Re-sharing needs fresh approval of the resulting revision.
This operation creates no messaging consent, employee role or tool credential.

## Voicemail observations

POST `/api/handset/voicemail/boxes` with name and kind (`personal`, `shared` or
`group`). Any active person can create their own personal box; it remains
private. Shared and group creation and membership administration are interim
native-owner operations. GET the box's path to read its observations, due IDs
and retained work history.

POST to a box's members suffix with revision, personId and enabled (zero or one).
Only its native owner administers membership. Every read and work action checks
current membership and the issuing person's current authority. Personal boxes
are never shared.

POST to a box's observations suffix with sourceId, text and language (`en` or
`es`). Only its owner records these labelled observations. Exact source replay
returns the existing item; a changed replay is refused. No supplied capture or
transcription assertion is accepted. Each new observation creates separate open
work without changing an earlier handled item.

POST to a box's items path followed by the item ID and claim, handle or reopen,
with the exact revision. One concurrent claim succeeds. Only the current
claimant or box owner handles or reopens. Handling removes that item from due
work for all current members. Reopening retains the append-only history and
makes it claimable again. This API confers no recording playback, consent or
outbound authority. Email, greeting, audio, clinical sharing and qualified speech
remain explicit contractual gaps.
