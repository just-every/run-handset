-- Exact native person + native number capability. No outbound/media/admin rights.
-- One-hour UI suggestion and hard 24-hour ceiling remain pending CT duration guidance.
CREATE TABLE hnd_number_access (
 id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision=1),
 person_id TEXT NOT NULL REFERENCES oa_operators(id),
 person_version INTEGER NOT NULL CHECK(person_version>0),
 number_id TEXT NOT NULL REFERENCES hnd_records(id),
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL CHECK(owner_version>0),
 expires_at INTEGER NOT NULL,
 revoked_at INTEGER,
 created_at INTEGER NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+86400000),
 CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX hnd_number_access_person_number ON hnd_number_access(person_id,number_id,revoked_at,expires_at);
-- Authority is immutable; first revocation is the only permitted change.
CREATE TRIGGER hnd_number_access_immutable BEFORE UPDATE ON hnd_number_access
 WHEN NEW.id IS NOT OLD.id OR NEW.revision IS NOT OLD.revision
 OR NEW.person_id IS NOT OLD.person_id OR NEW.person_version IS NOT OLD.person_version
 OR NEW.number_id IS NOT OLD.number_id OR NEW.created_by IS NOT OLD.created_by
 OR NEW.owner_version IS NOT OLD.owner_version OR NEW.expires_at IS NOT OLD.expires_at
 OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
 BEGIN SELECT RAISE(ABORT,'immutable_number_access'); END;
CREATE TRIGGER hnd_number_access_no_delete BEFORE DELETE ON hnd_number_access
 BEGIN SELECT RAISE(ABORT,'retain_number_access'); END;
ALTER TABLE hnd_sources ADD COLUMN consent_access_id TEXT REFERENCES hnd_number_access(id);
