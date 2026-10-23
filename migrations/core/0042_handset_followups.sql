-- A promise remains open after delivery. Only an owning-system state read,
-- explicit decline, or owned escalation can settle it. No customer sends here.
CREATE TABLE hnd_followups (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES hnd_cases(id),
 source_id TEXT NOT NULL UNIQUE REFERENCES hnd_records(id), source_hash TEXT NOT NULL,
 case_version INTEGER NOT NULL, owner_id TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL, obligation TEXT NOT NULL, due_at INTEGER NOT NULL,
 confirmation_basis TEXT NOT NULL, target TEXT NOT NULL, draft TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, approved_revision INTEGER, approved_by TEXT,
 approved_owner_version INTEGER, status TEXT NOT NULL DEFAULT 'open'
 CHECK(status IN ('open','confirmed','declined','escalated','canceled')),
 delivery TEXT NOT NULL DEFAULT 'draft'
 CHECK(delivery IN ('draft','approved','sending','received','uncertain','held','canceled')),
 operation_key TEXT NOT NULL UNIQUE, readback TEXT CHECK(readback IS NULL OR json_valid(readback)),
 reason TEXT NOT NULL DEFAULT '', next_due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE hnd_followup_history (
 id TEXT NOT NULL REFERENCES hnd_followups(id), revision INTEGER NOT NULL,
 body TEXT NOT NULL CHECK(json_valid(body)), actor TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(id,revision)
);
CREATE TRIGGER hnd_followup_history_no_update BEFORE UPDATE ON hnd_followup_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_followup_history_no_delete BEFORE DELETE ON hnd_followup_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
