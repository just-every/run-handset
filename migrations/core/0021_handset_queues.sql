-- Carrier-independent ACD state. A reservation is never proof of ringing or audio.
CREATE TABLE hnd_queues (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('longest_idle','round_robin')),
 skills TEXT NOT NULL CHECK(json_valid(skills)), max_wait_seconds INTEGER NOT NULL CHECK(max_wait_seconds BETWEEN 1 AND 86400),
 wrap_seconds INTEGER NOT NULL CHECK(wrap_seconds BETWEEN 0 AND 3600), max_waiting INTEGER NOT NULL CHECK(max_waiting BETWEEN 1 AND 1000),
 overflow_kind TEXT NOT NULL CHECK(overflow_kind IN ('queue','voicemail','receptionist')),
 overflow_queue_id TEXT REFERENCES hnd_queues(id), revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK((overflow_kind='queue' AND overflow_queue_id IS NOT NULL AND overflow_queue_id<>id) OR (overflow_kind<>'queue' AND overflow_queue_id IS NULL))
);
CREATE TABLE hnd_queue_agents (
 operator_id TEXT PRIMARY KEY REFERENCES oa_operators(id), skills TEXT NOT NULL CHECK(json_valid(skills)),
 languages TEXT NOT NULL CHECK(json_valid(languages)), capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 10),
 availability TEXT NOT NULL CHECK(availability IN ('available','busy','away','offline')),
 heartbeat_at INTEGER NOT NULL, idle_since INTEGER NOT NULL, last_assignment_at INTEGER NOT NULL DEFAULT 0,
 wrap_until INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE hnd_queue_memberships (
 queue_id TEXT NOT NULL REFERENCES hnd_queues(id), operator_id TEXT NOT NULL REFERENCES hnd_queue_agents(operator_id),
 logged_in INTEGER NOT NULL CHECK(logged_in IN (0,1)), priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 100),
 revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY(queue_id,operator_id)
);
CREATE TABLE hnd_queue_entries (
 id TEXT PRIMARY KEY, queue_id TEXT NOT NULL REFERENCES hnd_queues(id), origin_queue_id TEXT NOT NULL REFERENCES hnd_queues(id),
 call_id TEXT NOT NULL UNIQUE REFERENCES hnd_records(id), language TEXT NOT NULL, skills TEXT NOT NULL CHECK(json_valid(skills)),
 priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 100),
 state TEXT NOT NULL CHECK(state IN ('waiting','reserved','active','completed','abandoned','overflow')),
 agent_id TEXT REFERENCES hnd_queue_agents(operator_id), created_at INTEGER NOT NULL, queued_at INTEGER NOT NULL,
 deadline_at INTEGER NOT NULL, reserved_at INTEGER, accepted_at INTEGER, ended_at INTEGER,
 overflow_kind TEXT, reason TEXT NOT NULL DEFAULT '', visited TEXT NOT NULL CHECK(json_valid(visited)), revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX hnd_queue_waiting ON hnd_queue_entries(queue_id,state,priority DESC,queued_at,id);
CREATE TABLE hnd_queue_reservations (
 entry_id TEXT PRIMARY KEY REFERENCES hnd_queue_entries(id), agent_id TEXT NOT NULL REFERENCES hnd_queue_agents(operator_id),
 slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 10), lease_until INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','active')), UNIQUE(agent_id,slot)
);
CREATE TABLE hnd_queue_announcements (
 id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES hnd_queue_entries(id), entry_revision INTEGER NOT NULL,
 position INTEGER NOT NULL CHECK(position>0), language TEXT NOT NULL, text TEXT NOT NULL,
 estimated_wait_seconds INTEGER, estimate_basis TEXT NOT NULL,
 created_at INTEGER NOT NULL, delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state='pending'),
 UNIQUE(entry_id,entry_revision,position)
);
CREATE TABLE hnd_queue_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, queue_id TEXT REFERENCES hnd_queues(id),
 entry_id TEXT REFERENCES hnd_queue_entries(id), agent_id TEXT REFERENCES hnd_queue_agents(operator_id),
 type TEXT NOT NULL, occurred_at INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX hnd_queue_events_queue ON hnd_queue_events(queue_id,sequence);
CREATE TRIGGER hnd_queue_events_no_update BEFORE UPDATE ON hnd_queue_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_queue_events_no_delete BEFORE DELETE ON hnd_queue_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_queue_announcements_no_update BEFORE UPDATE ON hnd_queue_announcements BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_queue_announcements_no_delete BEFORE DELETE ON hnd_queue_announcements BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE hnd_queue_runtime (singleton INTEGER PRIMARY KEY CHECK(singleton=1), audit_actor TEXT NOT NULL);
CREATE TABLE hnd_queue_bindings (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES hnd_sources(id), queue_id TEXT NOT NULL REFERENCES hnd_queues(id),
 language TEXT NOT NULL, spanish_digit TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
);
