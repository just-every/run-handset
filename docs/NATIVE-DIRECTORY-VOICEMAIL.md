# Native contact and voicemail preparation

These native HTTP doors require a current Handset session. Writes require the
installation origin. Every response forbids caching. These are preparatory
APIs; no contact importer, tenant synchronization, carrier capture, transcription
service, voicemail audio, email delivery or expiring playback link is enabled.
The full HND-033 and HND-010 acceptance journeys remain required.

## Contact directory

`/api/handset/directory` supports GET and owner-authorized POST. A create request
contains `scope` (`personal` or `company`) and `contact`. Contact fields are
`name`, `phones`, optional `timezone`, `tags`, `consentReferences`, `sourceIds`,
`stopped` and `held`. A phone has `label`, `number`, optional `extension` and an
explicit `callingCode` when its number is national. International numbers start
with `+`. Formatting punctuation is removed; extensions remain separate. This
is syntax normalization, not proof of carrier reachability or a complete
regional numbering-plan validator. Missing timezone remains unknown.

A source reference has `source` and `id`. References are retained metadata;
they do not imply a live CRM connection or authority over its records. Neither
contact creation nor a consent reference grants messaging consent, staff access
or caller authentication. A stop and a hold are sticky under these preparatory
contact edits; this door has no action to clear either. Existing outbound
consent gates remain independently required.

GET a contact by its opaque ID. Owners can see company contacts and their own
personal contacts. A member can see only contacts explicitly shared with that
member. POST `grant` or `revoke` under a company contact with its `revision` and
`operatorId`; personal contacts cannot be shared by this preparatory door.
Withdrawal denies subsequent direct reads, listings and number matches.
Previously downloaded data remains outside local recall.

POST `update` with `revision` and the replacement `contact`. Source references,
stops and holds survive replacement. POST `merge` on the retained contact with
`revision`, `otherId`, `otherRevision` and the exact confirmation
`merge these exact contacts`. Both revisions must still be current. Both
contacts must have the same scope and native owner. The retained name wins;
phones, tags, source IDs and consent references are combined, stops and holds
are preserved, and an absent timezone can be filled. The removed contact becomes
a retained tombstone. Both contacts' member grants are removed; the owner must
explicitly regrant access to the combined record. No fuzzy or automatic merge
runs. There is no bulk import or reimport door for contacts yet; future readers
must use the shared `/app/import` door and preserve tombstones and stops.

GET `export` returns authorized native JSON with stable IDs. This is not CSV or
vCard export and does not claim round-trip import. GET `match` with a `number`
(and `callingCode` for national input) returns context only for a single visible
contact. Ambiguous and unknown numbers return no contact details or customer
record IDs. Even a unique match says `callerAuthenticated: false`. This lookup
is not yet connected to the carrier call intake or CRM screen-pop path.

## Voicemail work

`/api/handset/voicemail` supports GET and owner-authorized POST with `name` and
`kind` (`personal` or `shared`). Personal boxes are visible only to their native
owner. Shared-box membership is explicit. The owner posts `operatorId` and
boolean `active` to the box's `members` action. Current membership and current
native session authority are checked again inside each work transaction.

The owner may post a supplied-text observation to `observations` under a box:
`sourceId`, `transcript`, `language` (`en` or `es`) and confirmation
`record supplied text without capture qualification`. This is deliberately not
a capture receipt. Responses mark capture and transcription as unqualified.
An exact replay returns the same item; a changed replay is refused. No queued
email or carrier action results from an observation.

GET a box for its items and explicit due-item IDs. GET `items` followed by an
item's opaque ID for its state and append-only history. POST `claim`, `handled`
or `reopen` under that item with the current `revision`. A claim requires an
open, unassigned item. The same transaction fences membership, the exact item
revision, assignment and state, and appends an audit event. Concurrent claims
therefore produce one owner and one refusal. Only the claimant or box owner
can handle or reopen an item. Handling removes it from the box due list;
reopening restores it. A new observation creates separate open work without
rewriting the prior item's history. Member withdrawal immediately denies direct
reads and claims, including with an already signed-in session.

## Authority default awaiting policy review

Management is current-native-owner only. Company-contact reads and shared-box
work require explicit grants; personal data is not widened. Merge invalidates
read grants. No automatic destructive, messaging or carrier action is enabled.
This is an interim preparatory default, not a replacement for the full role,
scoping, owner-selected email modes or voicemail target. HND-033 and HND-010
remain PARTIAL pending ct approval and all remaining implementation and proof.
