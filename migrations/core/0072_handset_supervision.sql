-- Explicit native queue scopes; ownership alone confers no supervision read.
CREATE TABLE hnd_supervision_grants (
 id TEXT PRIMARY KEY,
 operator_id TEXT NOT NULL REFERENCES oa_operators(id), operator_version INTEGER NOT NULL,
 queue_id TEXT NOT NULL REFERENCES hnd_queues(id), can_intervene INTEGER NOT NULL CHECK(can_intervene IN (0,1)),
 issued_by TEXT NOT NULL REFERENCES oa_operators(id), issuer_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
 CHECK(expires_at>created_at AND expires_at<=created_at+86400000)
);
CREATE INDEX hnd_supervision_person_queue ON hnd_supervision_grants(operator_id,queue_id,expires_at);
CREATE TRIGGER hnd_supervision_grant_immutable BEFORE UPDATE ON hnd_supervision_grants
 WHEN NEW.id<>OLD.id OR NEW.operator_id<>OLD.operator_id OR NEW.operator_version<>OLD.operator_version
 OR NEW.queue_id<>OLD.queue_id OR NEW.can_intervene<>OLD.can_intervene OR NEW.issued_by<>OLD.issued_by
 OR NEW.issuer_version<>OLD.issuer_version OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
 OR OLD.revoked_at IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'immutable_supervision_scope'); END;
CREATE TABLE hnd_supervision_interventions (
 id TEXT PRIMARY KEY, queue_id TEXT NOT NULL REFERENCES hnd_queues(id), agent_id TEXT NOT NULL REFERENCES hnd_queue_agents(operator_id),
 actor_ref TEXT NOT NULL, occurred_at INTEGER NOT NULL, reason TEXT NOT NULL,
 before_state TEXT NOT NULL, availability TEXT NOT NULL, agent_revision INTEGER NOT NULL,
 grant_id TEXT NOT NULL REFERENCES hnd_supervision_grants(id)
);
CREATE INDEX hnd_supervision_timeline ON hnd_supervision_interventions(queue_id,occurred_at,id);
CREATE TRIGGER hnd_supervision_history_no_update BEFORE UPDATE ON hnd_supervision_interventions BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_supervision_history_no_delete BEFORE DELETE ON hnd_supervision_interventions BEGIN SELECT RAISE(ABORT,'append_only'); END;
