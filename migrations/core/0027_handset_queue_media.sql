-- Exact owner-approved media routes; approvals survive reload, never authority revocation.
CREATE TABLE hnd_queue_agent_routes (
 operator_id TEXT PRIMARY KEY REFERENCES hnd_queue_agents(operator_id), source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 kind TEXT NOT NULL CHECK(kind IN ('client','sip')), destination TEXT NOT NULL,
 revision INTEGER NOT NULL, approved_by TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 approved_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE hnd_queue_overflow_routes (
 queue_id TEXT PRIMARY KEY REFERENCES hnd_queues(id), kind TEXT NOT NULL CHECK(kind IN ('voicemail','receptionist')),
 url TEXT NOT NULL, revision INTEGER NOT NULL, approved_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL, approved_at INTEGER NOT NULL, revoked_at INTEGER
);
-- One identity per queue visit, including both sides of an overflow. Current
-- location may change, but an arrival in the original queue is never erased.
CREATE TABLE hnd_queue_visits (
 id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES hnd_queue_entries(id), queue_id TEXT NOT NULL REFERENCES hnd_queues(id),
 ordinal INTEGER NOT NULL, arrived_at INTEGER, left_at INTEGER, state TEXT NOT NULL, outcome_basis TEXT NOT NULL,
 UNIQUE(entry_id,ordinal)
);
ALTER TABLE hnd_queue_entries ADD COLUMN current_visit_id TEXT REFERENCES hnd_queue_visits(id);
INSERT INTO hnd_queue_visits(id,entry_id,queue_id,ordinal,arrived_at,left_at,state,outcome_basis)
 SELECT e.id||':'||j.key,e.id,j.value,CAST(j.key AS INTEGER)+1,
 CASE WHEN j.key=0 THEN e.created_at WHEN j.value=e.queue_id THEN e.queued_at ELSE NULL END,
 CASE WHEN j.value=e.queue_id THEN e.ended_at ELSE (SELECT min(v.occurred_at) FROM hnd_queue_events v WHERE v.entry_id=e.id AND v.queue_id=j.value AND v.type='entry.overflow') END,
 CASE WHEN j.value=e.queue_id THEN e.state ELSE 'overflow' END,'migrated native observation'
 FROM hnd_queue_entries e,json_each(e.visited) j;
UPDATE hnd_queue_entries SET current_visit_id=id||':'||(json_array_length(visited)-1);
CREATE INDEX hnd_queue_visits_queue ON hnd_queue_visits(queue_id,arrived_at,id);
-- Persist BEFORE emitting Dial. A retry can reconcile this offer, never emit it
-- again. Provider readback, not an expired local lease, resolves uncertainty.
CREATE TABLE hnd_queue_offers (
 id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES hnd_queue_entries(id), visit_id TEXT NOT NULL UNIQUE REFERENCES hnd_queue_visits(id),
 queue_id TEXT NOT NULL REFERENCES hnd_queues(id), agent_id TEXT NOT NULL REFERENCES hnd_queue_agents(operator_id),
 binding_id TEXT NOT NULL REFERENCES hnd_queue_bindings(id), source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 account_id TEXT NOT NULL, parent_call_sid TEXT NOT NULL, destination_kind TEXT NOT NULL CHECK(destination_kind IN ('client','sip')),
 destination TEXT NOT NULL, route_revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('uncertain','ringing','active','completed','failed')),
 child_call_sid TEXT UNIQUE, emitted_at INTEGER NOT NULL, observed_at INTEGER,
 connected_at INTEGER, completed_at INTEGER, service_seconds INTEGER, provider_status TEXT,
 cancel_requested_at INTEGER, revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX hnd_queue_offers_pending ON hnd_queue_offers(state,emitted_at);
CREATE TABLE hnd_queue_service_observations (
 offer_id TEXT PRIMARY KEY REFERENCES hnd_queue_offers(id), queue_id TEXT NOT NULL REFERENCES hnd_queues(id),
 language TEXT NOT NULL, skills TEXT NOT NULL, service_seconds INTEGER NOT NULL CHECK(service_seconds>0), observed_at INTEGER NOT NULL
);
CREATE TRIGGER hnd_queue_service_no_update BEFORE UPDATE ON hnd_queue_service_observations BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_queue_service_no_delete BEFORE DELETE ON hnd_queue_service_observations BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_queue_visit_state AFTER UPDATE OF state ON hnd_queue_entries BEGIN
 UPDATE hnd_queue_visits SET state=NEW.state,
 left_at=CASE WHEN NEW.state IN ('completed','abandoned','overflow') THEN NEW.ended_at ELSE left_at END,
 outcome_basis=CASE WHEN NEW.reason='' THEN outcome_basis ELSE NEW.reason END
 WHERE id=NEW.current_visit_id;
END;
ALTER TABLE hnd_queue_announcements ADD COLUMN estimate_samples INTEGER NOT NULL DEFAULT 0;
