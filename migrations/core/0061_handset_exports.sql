CREATE TABLE hnd_export_connectors (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('box','dropbox','google-drive','sftp')),
 destination TEXT NOT NULL CHECK(json_valid(destination)), preview TEXT NOT NULL CHECK(json_valid(preview)),
 owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650),
 created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE hnd_export_jobs (
 id TEXT PRIMARY KEY, connector_id TEXT NOT NULL REFERENCES hnd_export_connectors(id),
 person_id TEXT NOT NULL REFERENCES oa_operators(id), person_version INTEGER NOT NULL,
 filters TEXT NOT NULL CHECK(json_valid(filters)), key_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('building','prepared','approved','transferring','interrupted','verified','client_verified','revoked')),
 approved_by TEXT REFERENCES oa_operators(id), owner_version INTEGER, approved_at INTEGER,
 created_at INTEGER NOT NULL, retain_until INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
 error TEXT, manifest_hash TEXT
);
CREATE TABLE hnd_export_files (
 job_id TEXT NOT NULL REFERENCES hnd_export_jobs(id), file_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('audio','transcript','manifest')), recording_id TEXT REFERENCES hnd_records(id),
 native_id TEXT, source_id TEXT, external_id TEXT, call_id TEXT, recorded_at INTEGER,
 iv TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','ready','verified','client_verified','unavailable')),
 reason TEXT, plain_hash TEXT, cipher_hash TEXT, size_bytes INTEGER, remote_id TEXT,
 PRIMARY KEY(job_id,file_key)
);
CREATE TABLE hnd_export_schedules (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 filters TEXT NOT NULL CHECK(json_valid(filters)), recipient TEXT NOT NULL, due_at INTEGER NOT NULL,
 email_copy_policy TEXT NOT NULL, created_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('scheduled','sending','accepted','development','failed','uncertain','revoked','refused')),
 call_count INTEGER, leg_count INTEGER, csv_hash TEXT
);
CREATE INDEX hnd_export_schedules_due ON hnd_export_schedules(state,due_at);
