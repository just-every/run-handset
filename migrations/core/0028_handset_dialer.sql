-- Explicit human evidence is qualification input, never a product legal certification.
CREATE TABLE hnd_dialer_qualifications (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES hnd_sources(id), number_sid TEXT NOT NULL,
 definition TEXT NOT NULL CHECK(json_valid(definition)), approved_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE hnd_dialer_policies (
 id TEXT PRIMARY KEY, definition TEXT NOT NULL CHECK(json_valid(definition)), approved_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE hnd_dialer_lists (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 queue_id TEXT NOT NULL REFERENCES hnd_queues(id), qualification_id TEXT NOT NULL REFERENCES hnd_dialer_qualifications(id),
 definition TEXT NOT NULL CHECK(json_valid(definition)), snapshot_hash TEXT NOT NULL,
 approved_by TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 policy_id TEXT REFERENCES hnd_dialer_policies(id), policy_revision INTEGER,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, reserved_cents INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE hnd_dialer_recipients (
 list_id TEXT NOT NULL REFERENCES hnd_dialer_lists(id), ordinal INTEGER NOT NULL, case_id TEXT NOT NULL REFERENCES hnd_cases(id),
 person_id TEXT NOT NULL REFERENCES hnd_records(id), recipient TEXT NOT NULL, definition TEXT NOT NULL CHECK(json_valid(definition)),
 PRIMARY KEY(list_id,ordinal), UNIQUE(list_id,recipient)
);
CREATE TABLE hnd_dialer_checks (
 id TEXT PRIMARY KEY, list_id TEXT NOT NULL, ordinal INTEGER NOT NULL, definition TEXT NOT NULL CHECK(json_valid(definition)),
 checked_by TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL, checked_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 FOREIGN KEY(list_id,ordinal) REFERENCES hnd_dialer_recipients(list_id,ordinal)
);
CREATE TABLE hnd_dialer_sessions (
 id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES hnd_dialer_lists(id), mode TEXT NOT NULL CHECK(mode IN ('preview','progressive','power','parallel','predictive')),
 state TEXT NOT NULL CHECK(state IN ('running','paused','completed')), reason TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
 created_by TEXT NOT NULL REFERENCES oa_operators(id), created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE hnd_dialer_ready (
 agent_id TEXT PRIMARY KEY REFERENCES hnd_queue_agents(operator_id), source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 conference_sid TEXT NOT NULL UNIQUE, conference_name TEXT NOT NULL UNIQUE, agent_call_sid TEXT NOT NULL UNIQUE,
 approved_by TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL, observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE hnd_dialer_attempts (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES hnd_dialer_sessions(id), list_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 mode TEXT NOT NULL, event_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('held','uncertain','ringing','active','completed','failed')),
 reason TEXT NOT NULL, agent_id TEXT REFERENCES hnd_queue_agents(operator_id), account_id TEXT NOT NULL, from_number TEXT NOT NULL,
 recipient TEXT NOT NULL, conference_sid TEXT, conference_name TEXT, agent_call_sid TEXT,
 provider_sid TEXT UNIQUE, created_at INTEGER NOT NULL, observed_at INTEGER, answer_at INTEGER, ended_at INTEGER,
 bridge_emitted_at INTEGER, bridge_observed_at INTEGER, disposition TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(list_id,ordinal) REFERENCES hnd_dialer_recipients(list_id,ordinal), UNIQUE(session_id,event_key), UNIQUE(list_id,ordinal)
);
-- Only occupied slots are present. Uncertain paid effects never expire these rows.
CREATE TABLE hnd_dialer_reservations (
 attempt_id TEXT PRIMARY KEY REFERENCES hnd_dialer_attempts(id), agent_id TEXT NOT NULL REFERENCES hnd_queue_agents(operator_id),
 slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 10), created_at INTEGER NOT NULL, UNIQUE(agent_id,slot)
);
CREATE TRIGGER hnd_dialer_slot_guard BEFORE INSERT ON hnd_dialer_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_queue_reservations WHERE agent_id=NEW.agent_id AND slot=NEW.slot) THEN RAISE(ABORT,'inbound_slot_occupied') END;
END;
CREATE TRIGGER hnd_queue_dialer_slot_guard BEFORE INSERT ON hnd_queue_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_dialer_reservations WHERE agent_id=NEW.agent_id AND slot=NEW.slot) THEN RAISE(ABORT,'outbound_slot_occupied') END;
END;
CREATE TABLE hnd_dialer_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT REFERENCES hnd_dialer_sessions(id),
 list_id TEXT REFERENCES hnd_dialer_lists(id), attempt_id TEXT REFERENCES hnd_dialer_attempts(id),
 actor TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TRIGGER hnd_dialer_events_no_update BEFORE UPDATE ON hnd_dialer_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_dialer_events_no_delete BEFORE DELETE ON hnd_dialer_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_dialer_checks_no_update BEFORE UPDATE ON hnd_dialer_checks BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_dialer_checks_no_delete BEFORE DELETE ON hnd_dialer_checks BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_dialer_list_snapshot BEFORE UPDATE OF name,purpose,source_id,queue_id,qualification_id,definition,snapshot_hash,approved_by,owner_version,policy_id,policy_revision,expires_at ON hnd_dialer_lists BEGIN SELECT RAISE(ABORT,'immutable_list_snapshot'); END;
CREATE TRIGGER hnd_dialer_recipient_snapshot BEFORE UPDATE ON hnd_dialer_recipients BEGIN SELECT RAISE(ABORT,'immutable_list_snapshot'); END;
CREATE INDEX hnd_dialer_pending ON hnd_dialer_attempts(state,created_at);
