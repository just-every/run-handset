-- No dial is created by a recovery proposal. Existing qualified dialer doors
-- retain all list, consent, registry, spend and exact audience requirements.
CREATE TABLE hnd_recovery (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL UNIQUE REFERENCES hnd_cases(id),
 source_id TEXT NOT NULL REFERENCES hnd_sources(id), call_record_id TEXT NOT NULL REFERENCES hnd_records(id),
 queue_entry_id TEXT REFERENCES hnd_queue_entries(id), queue_place TEXT NOT NULL CHECK(json_valid(queue_place)),
 recipient TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('open','human','resolved','declined','stopped','escalated')),
 due_at INTEGER NOT NULL, max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 3),
 reason TEXT NOT NULL, resolution TEXT CHECK(resolution IS NULL OR json_valid(resolution)),
 revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE hnd_recovery_events (
 id TEXT PRIMARY KEY, recovery_id TEXT NOT NULL REFERENCES hnd_recovery(id),
 kind TEXT NOT NULL, evidence TEXT NOT NULL CHECK(json_valid(evidence)),
 actor TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER hnd_recovery_events_no_update BEFORE UPDATE ON hnd_recovery_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_recovery_events_no_delete BEFORE DELETE ON hnd_recovery_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
