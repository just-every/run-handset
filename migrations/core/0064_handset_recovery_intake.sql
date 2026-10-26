CREATE TABLE hnd_recovery_intake_policies (
 source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 revision INTEGER NOT NULL CHECK(revision > 0),
 source_revision INTEGER NOT NULL,
 timezone TEXT NOT NULL,
 hours TEXT NOT NULL CHECK(json_valid(hours)),
 approved_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 revoked_at INTEGER,
 PRIMARY KEY(source_id,revision)
);
CREATE TRIGGER hnd_recovery_intake_no_update BEFORE UPDATE ON hnd_recovery_intake_policies BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_recovery_intake_no_delete BEFORE DELETE ON hnd_recovery_intake_policies BEGIN SELECT RAISE(ABORT,'append_only'); END;
