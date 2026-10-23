CREATE TABLE hnd_number_compliance (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES hnd_sources(id), number_id TEXT NOT NULL REFERENCES hnd_records(id),
 kind TEXT NOT NULL, reference TEXT NOT NULL, report TEXT NOT NULL CHECK(json_valid(report)),
 owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 due_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared','reviewed','follow_up')),
 plan TEXT NOT NULL, approval_note TEXT NOT NULL DEFAULT '', provider_state TEXT NOT NULL DEFAULT 'unknown',
 readback TEXT CHECK(readback IS NULL OR json_valid(readback)), revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(number_id,kind,reference)
);
CREATE TABLE hnd_number_compliance_events (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES hnd_number_compliance(id), kind TEXT NOT NULL,
 evidence TEXT NOT NULL CHECK(json_valid(evidence)), actor_id TEXT NOT NULL, actor_version INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER hnd_number_compliance_events_no_update BEFORE UPDATE ON hnd_number_compliance_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_number_compliance_events_no_delete BEFORE DELETE ON hnd_number_compliance_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
