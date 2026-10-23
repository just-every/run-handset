CREATE TABLE hnd_rule_previews (
 id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, expected_revision INTEGER NOT NULL,
 definition TEXT NOT NULL CHECK(json_valid(definition)), sample_id TEXT NOT NULL REFERENCES hnd_records(id),
 owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE hnd_rules (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, definition TEXT NOT NULL CHECK(json_valid(definition)),
 state TEXT NOT NULL CHECK(state IN ('active','paused')), owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE hnd_rule_versions (
 id TEXT NOT NULL REFERENCES hnd_rules(id), revision INTEGER NOT NULL,
 definition TEXT NOT NULL CHECK(json_valid(definition)), owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(id,revision)
);
CREATE TABLE hnd_rule_events (
 record_id TEXT PRIMARY KEY REFERENCES hnd_records(id), trigger TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE hnd_rule_runs (
 id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES hnd_rules(id), rule_revision INTEGER NOT NULL,
 record_id TEXT NOT NULL REFERENCES hnd_records(id), case_id TEXT NOT NULL REFERENCES hnd_cases(id), case_version INTEGER NOT NULL,
 owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL, action TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','sending','accepted','uncertain','failed','canceled','owned','held')),
 work_status TEXT NOT NULL DEFAULT 'open' CHECK(work_status='open'), due_at INTEGER NOT NULL,
 next_due_at INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(rule_id,record_id), UNIQUE(record_id,action,owner_id)
);
CREATE TRIGGER hnd_rule_versions_no_update BEFORE UPDATE ON hnd_rule_versions BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_rule_versions_no_delete BEFORE DELETE ON hnd_rule_versions BEGIN SELECT RAISE(ABORT,'append_only'); END;
