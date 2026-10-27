PRAGMA defer_foreign_keys = ON;
CREATE TABLE hnd_recovery_next (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES hnd_cases(id),
 source_id TEXT NOT NULL REFERENCES hnd_sources(id), call_record_id TEXT NOT NULL REFERENCES hnd_records(id),
 queue_entry_id TEXT REFERENCES hnd_queue_entries(id), queue_place TEXT NOT NULL CHECK(json_valid(queue_place)),
 recipient TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('open','human','resolved','declined','stopped','escalated')),
 due_at INTEGER NOT NULL, max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 3),
 reason TEXT NOT NULL, resolution TEXT CHECK(resolution IS NULL OR json_valid(resolution)),
 revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO hnd_recovery_next SELECT * FROM hnd_recovery;
DROP TABLE hnd_recovery;
ALTER TABLE hnd_recovery_next RENAME TO hnd_recovery;
CREATE UNIQUE INDEX hnd_one_unresolved_need ON hnd_recovery(case_id) WHERE state NOT IN ('resolved','declined');
CREATE UNIQUE INDEX hnd_recovery_booking_once ON hnd_recovery(json_extract(resolution,'$.outcomeId')) WHERE resolution IS NOT NULL AND json_extract(resolution,'$.outcomeId') IS NOT NULL;
CREATE TABLE hnd_recovery_links (recovery_id TEXT PRIMARY KEY REFERENCES hnd_recovery(id), previous_id TEXT NOT NULL REFERENCES hnd_recovery(id));
CREATE TABLE hnd_recovery_access (
 id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES oa_operators(id), person_version INTEGER NOT NULL,
 number_id TEXT NOT NULL REFERENCES hnd_records(id), capabilities TEXT NOT NULL CHECK(json_valid(capabilities)),
 fallback_id TEXT NOT NULL REFERENCES oa_operators(id), fallback_version INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
);
PRAGMA defer_foreign_keys = OFF;
