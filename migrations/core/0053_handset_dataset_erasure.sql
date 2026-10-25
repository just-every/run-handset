-- Owner erasure is the sole exception to normal report immutability.
CREATE TABLE hnd_erasure_guard (operation TEXT PRIMARY KEY);
CREATE TABLE hnd_dataset_erasures (
 id TEXT PRIMARY KEY, target_hash TEXT NOT NULL UNIQUE, committed_at TEXT NOT NULL,
 dataset_rows INTEGER NOT NULL, revision_rows INTEGER NOT NULL,
 report_rows INTEGER NOT NULL, schedule_rows INTEGER NOT NULL
);
CREATE TRIGGER hnd_dataset_erasures_no_update BEFORE UPDATE ON hnd_dataset_erasures BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_dataset_erasures_no_delete BEFORE DELETE ON hnd_dataset_erasures BEGIN SELECT RAISE(ABORT,'append_only'); END;
DROP TRIGGER hnd_metric_reports_no_delete;
CREATE TRIGGER hnd_metric_reports_no_delete BEFORE DELETE ON hnd_metric_reports
 WHEN NOT EXISTS(SELECT 1 FROM hnd_erasure_guard) BEGIN SELECT RAISE(ABORT,'append_only'); END;
