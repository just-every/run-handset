-- HND-047: exact native person, installation audit only. All times are epoch milliseconds.
-- One-hour UI suggestion and a hard 24-hour ceiling are conservative pending CT duration guidance.
CREATE TABLE hnd_audit_access (
 id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision=1),
 scope TEXT NOT NULL CHECK(scope='installation-audit'),
 person_id TEXT NOT NULL REFERENCES oa_operators(id),
 person_version INTEGER NOT NULL CHECK(person_version>0),
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL CHECK(owner_version>0),
 allow_read INTEGER NOT NULL CHECK(allow_read=1),
 allow_export INTEGER NOT NULL CHECK(allow_export IN (0,1)),
 expires_at INTEGER NOT NULL,
 revoked_at INTEGER,
 created_at INTEGER NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+86400000),
 CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX hnd_audit_access_person ON hnd_audit_access(person_id,revoked_at,expires_at);
-- Authority is immutable. A change requires a new capability; only first revocation is allowed.
CREATE TRIGGER hnd_audit_access_immutable BEFORE UPDATE ON hnd_audit_access
 WHEN NEW.id IS NOT OLD.id OR NEW.revision IS NOT OLD.revision OR NEW.scope IS NOT OLD.scope
 OR NEW.person_id IS NOT OLD.person_id OR NEW.person_version IS NOT OLD.person_version
 OR NEW.created_by IS NOT OLD.created_by OR NEW.owner_version IS NOT OLD.owner_version
 OR NEW.allow_read IS NOT OLD.allow_read OR NEW.allow_export IS NOT OLD.allow_export
 OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
 BEGIN SELECT RAISE(ABORT,'immutable_audit_access'); END;
CREATE TRIGGER hnd_audit_access_no_delete BEFORE DELETE ON hnd_audit_access
 BEGIN SELECT RAISE(ABORT,'retain_audit_access'); END;
