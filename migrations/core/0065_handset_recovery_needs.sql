PRAGMA defer_foreign_keys = ON;
CREATE TABLE hnd_recovery_next (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES hnd_cases(id),
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
CREATE UNIQUE INDEX hnd_recovery_active_need ON hnd_recovery(case_id) WHERE state IN ('open','human','escalated');
CREATE INDEX hnd_recovery_case_needs ON hnd_recovery(case_id,created_at);
CREATE TABLE hnd_recovery_calls (
 call_id TEXT PRIMARY KEY REFERENCES hnd_records(id),
 recovery_id TEXT NOT NULL REFERENCES hnd_recovery(id)
);
CREATE TRIGGER hnd_recovery_calls_no_update BEFORE UPDATE ON hnd_recovery_calls BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_recovery_calls_no_delete BEFORE DELETE ON hnd_recovery_calls BEGIN SELECT RAISE(ABORT,'append_only'); END;
WITH RECURSIVE roots(recovery_id,call_id,parent_id,kind) AS (
 SELECT n.id,r.id,r.parent_id,r.kind FROM hnd_recovery n JOIN hnd_records r ON r.id=n.call_record_id
 UNION ALL SELECT roots.recovery_id,r.id,r.parent_id,r.kind FROM roots JOIN hnd_records r ON r.id=roots.parent_id WHERE roots.kind<>'call_session'
) INSERT INTO hnd_recovery_calls SELECT call_id,recovery_id FROM roots WHERE kind='call_session';

-- Verify every reference before restoring immediate foreign-key enforcement.
INSERT INTO hnd_guard(ok) SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
DELETE FROM hnd_guard;
PRAGMA defer_foreign_keys = OFF;
