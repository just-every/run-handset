-- Exact human review binds an existing request to current media or a single
-- qualified preview recipient. No call is launched by inserting an approval.
CREATE TABLE hnd_frontdesk_controls (
 operation_id TEXT PRIMARY KEY REFERENCES hnd_frontdesk_operations(id), snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
 approved_by TEXT NOT NULL, owner_version INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 session_id TEXT, observed_at INTEGER, observation TEXT NOT NULL DEFAULT 'unconfirmed'
);
CREATE TRIGGER hnd_frontdesk_request_fixed BEFORE UPDATE ON hnd_frontdesk_operations
 WHEN NEW.id!=OLD.id OR NEW.delegation_id!=OLD.delegation_id OR NEW.actor!=OLD.actor OR NEW.principal!=OLD.principal
 OR NEW.kind!=OLD.kind OR NEW.call_id IS NOT OLD.call_id OR NEW.target IS NOT OLD.target OR NEW.line_revision!=OLD.line_revision
 OR NEW.idempotency_key!=OLD.idempotency_key OR NEW.created_at!=OLD.created_at
 BEGIN SELECT RAISE(ABORT,'append_only_request'); END;
CREATE TRIGGER hnd_frontdesk_request_no_delete BEFORE DELETE ON hnd_frontdesk_operations BEGIN SELECT RAISE(ABORT,'append_only_request'); END;
CREATE TRIGGER hnd_frontdesk_approval_fixed BEFORE UPDATE ON hnd_frontdesk_controls
 WHEN NEW.operation_id!=OLD.operation_id OR NEW.snapshot!=OLD.snapshot OR NEW.approved_by!=OLD.approved_by
 OR NEW.owner_version!=OLD.owner_version OR NEW.expires_at!=OLD.expires_at
 BEGIN SELECT RAISE(ABORT,'append_only_approval'); END;
