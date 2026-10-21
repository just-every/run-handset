-- Restored evidence is a separate immutable ledger. It never restores authority.
CREATE TABLE hnd_audit_archives (
 checkpoint TEXT PRIMARY KEY, rows_json TEXT NOT NULL CHECK(json_valid(rows_json)),
 imported_at INTEGER NOT NULL, imported_by TEXT NOT NULL
);
CREATE TRIGGER hnd_archives_no_update BEFORE UPDATE ON hnd_audit_archives BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_archives_no_delete BEFORE DELETE ON hnd_audit_archives BEGIN SELECT RAISE(ABORT,'append_only'); END;
