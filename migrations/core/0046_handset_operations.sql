CREATE TABLE hnd_operations (
 id TEXT PRIMARY KEY, call_record_id TEXT NOT NULL REFERENCES hnd_records(id), source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), state TEXT NOT NULL CHECK(state IN ('proposed','approved','declined')),
 decision_note TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE hnd_operations_decisions (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES hnd_operations(id),
 decision TEXT NOT NULL, note TEXT NOT NULL, actor_id TEXT NOT NULL, actor_version INTEGER NOT NULL, created_at INTEGER NOT NULL
);
