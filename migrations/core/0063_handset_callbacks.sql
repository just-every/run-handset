CREATE TABLE hnd_callback_policies (
 source_id TEXT PRIMARY KEY REFERENCES hnd_sources(id),
 queue_id TEXT NOT NULL REFERENCES hnd_queues(id),
 staff_target TEXT NOT NULL CHECK(staff_target GLOB '+[1-9]*'),
 business_name TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 3),
 retry_seconds INTEGER NOT NULL CHECK(retry_seconds BETWEEN 60 AND 86400),
 approved_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL,
 revision INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE hnd_callbacks (
 id TEXT PRIMARY KEY,
 recovery_id TEXT NOT NULL REFERENCES hnd_recovery(id),
 case_id TEXT NOT NULL REFERENCES hnd_cases(id),
 source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 queue_id TEXT REFERENCES hnd_queues(id),
 queue_entry_id TEXT UNIQUE REFERENCES hnd_queue_entries(id),
 kind TEXT NOT NULL CHECK(kind IN ('virtual_hold','scheduled')),
 recipient TEXT NOT NULL,
 queued_at INTEGER NOT NULL,
 priority INTEGER NOT NULL,
 due_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('waiting','dialing','uncertain','completed','declined','unanswered','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0,
 reason TEXT NOT NULL,
 consent TEXT NOT NULL CHECK(json_valid(consent)),
 owner_id TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL,
 revision INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX hnd_callbacks_order ON hnd_callbacks(source_id,state,priority DESC,queued_at,id);
CREATE TABLE hnd_callback_attempts (
 id TEXT PRIMARY KEY,
 callback_id TEXT NOT NULL REFERENCES hnd_callbacks(id),
 attempt_no INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('claimed','created','answered','completed','declined','no_choice','no-answer','busy','failed','canceled','staff_unavailable','uncertain')),
 provider_sid TEXT,
 reason TEXT NOT NULL,
 claimed_at INTEGER NOT NULL,
 ended_at INTEGER,
 UNIQUE(callback_id,attempt_no)
);
CREATE TABLE hnd_callback_events (
 id TEXT PRIMARY KEY,
 callback_id TEXT NOT NULL REFERENCES hnd_callbacks(id),
 kind TEXT NOT NULL,
 evidence TEXT NOT NULL CHECK(json_valid(evidence)),
 occurred_at INTEGER NOT NULL
);
CREATE TRIGGER hnd_callback_events_no_update BEFORE UPDATE ON hnd_callback_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_callback_events_no_delete BEFORE DELETE ON hnd_callback_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
