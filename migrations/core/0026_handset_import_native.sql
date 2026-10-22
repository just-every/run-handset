-- Keep product revisions numeric while retaining the shared kit's opaque revisions.
CREATE TABLE hnd_metric_import_revisions (
 id TEXT PRIMARY KEY REFERENCES hnd_metric_datasets(id) ON DELETE CASCADE,
 kit_revision TEXT NOT NULL,
 native_revision INTEGER NOT NULL,
 value TEXT NOT NULL
);
CREATE TABLE hnd_import_events (
 id TEXT PRIMARY KEY,
 actor_id TEXT NOT NULL,
 action TEXT NOT NULL,
 occurred_at INTEGER NOT NULL
);
