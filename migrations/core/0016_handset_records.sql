-- Native Handset records. Applied history is never rewritten.
CREATE TABLE hnd_guard (ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE hnd_cases (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES oa_operators(id),
 due_at INTEGER, promise TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('open','closed')),
 handled INTEGER NOT NULL DEFAULT 0 CHECK(handled IN (0,1)), unread INTEGER NOT NULL DEFAULT 1 CHECK(unread IN (0,1)),
 version INTEGER NOT NULL CHECK(version>0), actor_id TEXT NOT NULL, updated_at INTEGER NOT NULL, close_reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE hnd_case_history (
 case_id TEXT NOT NULL REFERENCES hnd_cases(id), version INTEGER NOT NULL, snapshot TEXT NOT NULL,
 actor_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, PRIMARY KEY(case_id,version)
);
CREATE TRIGGER hnd_case_created AFTER INSERT ON hnd_cases BEGIN
 INSERT INTO hnd_case_history VALUES(NEW.id,NEW.version,json_object('title',NEW.title,'ownerId',NEW.owner_id,'dueAt',NEW.due_at,'promise',NEW.promise,'status',NEW.status,'handled',NEW.handled,'unread',NEW.unread,'closeReason',NEW.close_reason),NEW.actor_id,NEW.updated_at);
END;
CREATE TRIGGER hnd_case_changed AFTER UPDATE ON hnd_cases BEGIN
 INSERT INTO hnd_case_history VALUES(NEW.id,NEW.version,json_object('title',NEW.title,'ownerId',NEW.owner_id,'dueAt',NEW.due_at,'promise',NEW.promise,'status',NEW.status,'handled',NEW.handled,'unread',NEW.unread,'closeReason',NEW.close_reason),NEW.actor_id,NEW.updated_at);
END;
CREATE TRIGGER hnd_history_no_update BEFORE UPDATE ON hnd_case_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_history_no_delete BEFORE DELETE ON hnd_case_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE hnd_records (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source='native'), source_id TEXT NOT NULL,
 occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
 case_id TEXT REFERENCES hnd_cases(id), parent_id TEXT REFERENCES hnd_records(id),
 supersedes_id TEXT UNIQUE REFERENCES hnd_records(id), data TEXT NOT NULL CHECK(json_valid(data)),
 actor_id TEXT NOT NULL, UNIQUE(kind,source,source_id)
);
CREATE INDEX hnd_records_case ON hnd_records(case_id,occurred_at,id);
CREATE TABLE hnd_record_links (
 record_id TEXT NOT NULL REFERENCES hnd_records(id), target_id TEXT NOT NULL REFERENCES hnd_records(id),
 relation TEXT NOT NULL, PRIMARY KEY(record_id,target_id,relation)
);
CREATE TRIGGER hnd_records_no_update BEFORE UPDATE ON hnd_records BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_records_no_delete BEFORE DELETE ON hnd_records BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_links_no_update BEFORE UPDATE ON hnd_record_links BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_links_no_delete BEFORE DELETE ON hnd_record_links BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE hnd_filters (
 id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES oa_operators(id), name TEXT NOT NULL,
 query TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(operator_id,name)
);
-- The ledger holds only server-generated opaque references and fixed vocabulary.
CREATE TABLE hnd_actor_refs (operator_id TEXT PRIMARY KEY, pseudonym TEXT NOT NULL UNIQUE);
CREATE TABLE hnd_audit (
 sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, action TEXT NOT NULL,
 policy TEXT NOT NULL, subject TEXT NOT NULL, outcome TEXT NOT NULL, occurred_at INTEGER NOT NULL,
 previous_hash TEXT NOT NULL UNIQUE, hash TEXT NOT NULL UNIQUE
);
CREATE TRIGGER hnd_audit_no_update BEFORE UPDATE ON hnd_audit BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_audit_no_delete BEFORE DELETE ON hnd_audit BEGIN SELECT RAISE(ABORT,'append_only'); END;
