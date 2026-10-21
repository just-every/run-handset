# Queue metric imports

The owner opens `/app/import`, supplies queue-dataset JSON, reviews counts,
rejections, differences and the exact fingerprint, and explicitly applies that
plan. Bounded apply resumes from shared history; reconciliation reads native
`hnd_metric_datasets`, and preserving Undo keeps later native edits.

The only import engine is pinned Base's shared operator/grant door. The HTML
forms call that same operator handler. `X-Import-Source: queue-dataset` is the
server allow-listed source for every operator API call. The format is one
`{id,name,entries,agents}` dataset or an array of such datasets, with the public
metrics model's validation, timestamps in milliseconds and durations in seconds.
Maximum export size is 2 MiB, each dataset 1 MiB, and at most 100 datasets.
Importing cannot dial, send messages, start work or grant access. Data absent
from a catch-up is retained and explained, never automatically deleted.

Business trust uses the existing owner-claim verifier and the complete
server-owned RER_OWNER_CLAIM trust configuration only when present. There is no
placeholder key or signer. Grants remain off until the owner explicitly enables
them on this screen; RER_IMPORT_DOOR alone does not enable them. The permanent
door key is handset-import-door-v1, including when trust is added later. Current
native owner sessions, same-origin checks and same-transaction session predicates
protect owner operations. The shared approval history records exact fingerprints
and approval authority; owner setting changes are recorded atomically in
hnd_import_events. Revoked Business key IDs are permanent.

Native dataset revisions stay numeric. hnd_metric_import_revisions preserves the
kit's opaque revision only while native revision and exact canonical value match
its snapshot. Product writes serialize value with the kit's canonicalJson and
increment the native revision. Adapter mutations, exact value/revision guards
and the current owner predicate share D1 transactions. A catch-up upserts the
native row. Undo restores the earlier value or removes an unchanged import-owned
row and preserves edits.

Private original uploads/chunks, plan snapshots/chunks, approval/lineage rows,
provenance, reversal reports and archive bytes are retained import custody. They
must participate in any future product/subject erasure and retirement workflow
via the shared kit erasure APIs. Installation settings and permanent revoked key
IDs survive erasure. This prerequisite adds no product/subject erasure door and
does not claim complete HND-053 source-account migration or HND-066 erasure.

Vendored without modification from Base commit
d1249b3d696c4011e9c72de2097f3757436074a6:
- modules/import-kit/src/** -> src/modules/import-kit/src/**
- modules/import-kit/schema/** -> src/modules/import-kit/schema/**
- modules/d1-transport/index.mjs -> src/modules/d1-transport/index.mjs
- modules/d1-transport/index.d.mts -> src/modules/d1-transport/index.d.mts

0024 applies every fresh kit schema in initializeD1ImportStorage order (including
its bundled evolutions); 0025 applies the fresh current door schema, which
already includes the door apply-failure, scope and archive evolutions. 0026
adds edition-owned revision markers and settings audit events.
