-- Optional principal extends the hash only on attributed on-behalf events.
-- Existing rows and their independently stored checkpoints stay valid.
ALTER TABLE hnd_audit ADD COLUMN principal TEXT;
CREATE TABLE hnd_frontdesk_lines (
 id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES oa_operators(id), number_id TEXT NOT NULL REFERENCES hnd_records(id),
 source_id TEXT NOT NULL REFERENCES hnd_sources(id), timezone TEXT NOT NULL, opens TEXT NOT NULL, closes TEXT NOT NULL,
 weekdays TEXT NOT NULL CHECK(json_valid(weekdays)), dnd INTEGER NOT NULL CHECK(dnd IN (0,1)),
 forward_to TEXT, revision INTEGER NOT NULL, created_by TEXT NOT NULL, owner_version INTEGER NOT NULL
);
CREATE TABLE hnd_delegations (
 id TEXT PRIMARY KEY, line_id TEXT NOT NULL REFERENCES hnd_frontdesk_lines(id), assistant_id TEXT NOT NULL REFERENCES oa_operators(id),
 assistant_version INTEGER NOT NULL, principal_version INTEGER NOT NULL, created_by TEXT NOT NULL, owner_version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE hnd_frontdesk_presence (
 operator_id TEXT PRIMARY KEY REFERENCES oa_operators(id), state TEXT NOT NULL CHECK(state IN ('available','busy','away','dnd','offline')),
 observed_at INTEGER NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE hnd_frontdesk_operations (
 id TEXT PRIMARY KEY, delegation_id TEXT NOT NULL REFERENCES hnd_delegations(id), actor TEXT NOT NULL, principal TEXT NOT NULL,
 kind TEXT NOT NULL, call_id TEXT, target TEXT, line_revision INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('held','uncertain','provider_observed','refused')), created_at INTEGER NOT NULL,
 UNIQUE(delegation_id,idempotency_key)
);
CREATE TABLE hnd_recording_grants (
 id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES hnd_records(id), person_id TEXT NOT NULL REFERENCES oa_operators(id),
 person_version INTEGER NOT NULL, created_by TEXT NOT NULL, owner_version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
);
