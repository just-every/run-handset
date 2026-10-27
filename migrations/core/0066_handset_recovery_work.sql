CREATE UNIQUE INDEX hnd_recovery_booking_once ON hnd_recovery(json_extract(resolution,'$.outcomeId')) WHERE resolution IS NOT NULL AND json_extract(resolution,'$.outcomeId') IS NOT NULL;
CREATE TABLE hnd_recovery_links (recovery_id TEXT PRIMARY KEY REFERENCES hnd_recovery(id), previous_id TEXT NOT NULL REFERENCES hnd_recovery(id));
CREATE TABLE hnd_recovery_access (
 id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES oa_operators(id), person_version INTEGER NOT NULL,
 number_id TEXT NOT NULL REFERENCES hnd_records(id), capabilities TEXT NOT NULL CHECK(json_valid(capabilities)),
 fallback_id TEXT NOT NULL REFERENCES oa_operators(id), fallback_version INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
);
