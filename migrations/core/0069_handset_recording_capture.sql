CREATE TABLE hnd_capture_sessions (
 id TEXT PRIMARY KEY,
 call_id TEXT NOT NULL REFERENCES hnd_records(id),
 source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 source_revision INTEGER NOT NULL,
 account_id TEXT NOT NULL,
 call_sid TEXT NOT NULL,
 created_by TEXT NOT NULL,
 owner_version INTEGER NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL CHECK(state IN ('ready','blocked','capturing','paused','stopped','uncertain','erasing','erased')),
 jurisdiction TEXT NOT NULL CHECK(jurisdiction IN ('all-party','unknown')),
 participants TEXT NOT NULL,
 announced_revision INTEGER,
 recording_sid TEXT,
 retain_until INTEGER,
 hold INTEGER NOT NULL DEFAULT 0 CHECK(hold IN (0,1)),
 created_at INTEGER NOT NULL
);
CREATE INDEX hnd_capture_call ON hnd_capture_sessions(call_id,recording_sid);
CREATE TABLE hnd_capture_boundaries (
 session_id TEXT NOT NULL REFERENCES hnd_capture_sessions(id),
 revision INTEGER NOT NULL,
 kind TEXT NOT NULL,
 occurred_at INTEGER NOT NULL,
 PRIMARY KEY(session_id,revision)
);
