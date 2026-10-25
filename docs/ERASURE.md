# Owner erasure

HND-066 remains partial. Owners reach `/app/admin/erasure` from the erasure
settings link in `/app/import`. The corresponding native endpoints are
`GET /api/handset/erasure` and `POST /api/handset/erasure/erase`.
Existing native sessions, current owner authority and same-origin mutation
checks protect both forms and direct requests. Application credentials confer
no erasure rights.

The supported operation selects `entity: queue-dataset`, its exact `targetId`
and numeric `revision`, and requires `confirm: erase this exact dataset and
retained copies`. A changed revision refuses the request. Unsupported entities
are refused; absence of a producer is never reported as erased data.

The D1 deletion batch removes the native dataset and import revision, rewrites
its source custody through the shared import kit, withdraws retained uploads
and private plan bytes, removes dependent report snapshots, and stops pending
report schedules. Opaque bundles can contain several subjects: affected whole
originals and destination plan snapshots become unavailable, including their
other records' source bytes. Native peer datasets stay. The confirmation
explicitly approves withdrawing whole affected originals.

Counts for the native stores and the import kit's affected stores, an opaque
receipt and a committed timestamp are returned only after the batch commits.
Deletion failure rolls back the receipts, source withdrawal and native deletes.
The immutable native receipt contains a hashed target identity and counts;
the existing audit holds only fixed action names and opaque subjects. Neither
receipt retains imported text. Normal report deletion stays prohibited.

Reports capture the import erasure epoch before reading sources. Publication,
export and delivery claims recheck it in their D1 transaction. Erasure also
refuses while a report is marked sending, because that copy may already have
left local custody. Crashed sending work needs a future repair flow. A queued
report suppressed by deletion cannot become sending from its old snapshot.
Once an external send begins, this limited door offers no recall guarantee.

The same transaction advances the shared portability redaction checkpoint and
invalidates local archive transfer copies. The import kit records erased source
and target fences: an old upload cannot reintroduce the erased source, and an
old reviewed plan cannot apply. Cancelling an unapplied plan remains allowed
and cannot recreate a dataset. A later journal must accompany an older archive
at an offline receiving installation; no installation can infer an unavailable
later offline deletion. Downloaded archives and already delivered messages stay
outside local deletion control.

## Remaining qualification

This operation does not implement installation-wide erasure. Contacts, callers,
employees, canonical cases, audio, fax, MMS, transcripts, indexes, embeddings,
quality content, agent context, pending AI, notifications and other export jobs
still need their own cascades and fences. Provider deletion and independent
readback, named legal holds with exact minimized residue and review owner,
complete installation restore with a later journal, and five-minute absence
checks through search, read, export and model requests remain unproved.
Pending-provider and held screens are consequently not claimed. No new provider
request, retention rule or automatic deletion is enabled.

The committed integration proof is in `tests/handset-import.mjs`, named
“Owner dataset erasure commits native and import custody counts and refuses
stale resurrection”. The existing browser suite in
`tests/handset-console-browser.mjs` proves the erasure settings, populated,
stale, failed, committed, receipt and denied states at 1440 and 390 pixels.
Every control has visible text; there are no icon-only controls on this surface.
