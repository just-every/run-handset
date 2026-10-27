CREATE TABLE hnd_metric_dashboards (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL,
 updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL
);
ALTER TABLE hnd_metric_schedules ADD COLUMN dashboard_definition TEXT;
