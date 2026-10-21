CREATE TABLE hnd_metric_datasets (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), value TEXT NOT NULL CHECK(json_valid(value)));
CREATE TABLE hnd_metric_configs (queue_id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), actor_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(queue_id,revision));
CREATE TRIGGER hnd_metric_configs_no_update BEFORE UPDATE ON hnd_metric_configs BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_metric_configs_no_delete BEFORE DELETE ON hnd_metric_configs BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE hnd_metric_reports (id TEXT PRIMARY KEY, queue_id TEXT NOT NULL, config_revision INTEGER NOT NULL, source_hash TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), created_at INTEGER NOT NULL);
CREATE TRIGGER hnd_metric_reports_no_update BEFORE UPDATE ON hnd_metric_reports BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_metric_reports_no_delete BEFORE DELETE ON hnd_metric_reports BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE hnd_metric_schedules (id TEXT PRIMARY KEY, queue_id TEXT NOT NULL, config_revision INTEGER NOT NULL, owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL, recipient TEXT NOT NULL, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('scheduled','sending','accepted','failed','uncertain','refused','development')), report_id TEXT REFERENCES hnd_metric_reports(id));
