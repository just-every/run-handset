CREATE TABLE hnd_grants (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 definition TEXT NOT NULL CHECK(json_valid(definition)), revision INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, revoked_at INTEGER, reserved_cents INTEGER NOT NULL DEFAULT 0 CHECK(reserved_cents>=0), created_at INTEGER NOT NULL
);
CREATE TABLE hnd_approvals (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES hnd_grants(id), grant_revision INTEGER NOT NULL,
 state_hash TEXT NOT NULL, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 approved_by TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, consumed_by TEXT UNIQUE, revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE hnd_standing (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES hnd_grants(id), revision INTEGER NOT NULL,
 bounds TEXT NOT NULL CHECK(json_valid(bounds)), approved_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE hnd_authority_history (
 id TEXT PRIMARY KEY, subject TEXT NOT NULL, revision INTEGER NOT NULL, definition TEXT NOT NULL,
 approved_by TEXT NOT NULL, occurred_at INTEGER NOT NULL
);
CREATE TRIGGER hnd_authority_history_no_update BEFORE UPDATE ON hnd_authority_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_authority_history_no_delete BEFORE DELETE ON hnd_authority_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE hnd_jobs (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES hnd_grants(id), grant_revision INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL, state_hash TEXT NOT NULL, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 approval_id TEXT REFERENCES hnd_approvals(id), standing_id TEXT REFERENCES hnd_standing(id), standing_revision INTEGER,
 approved_by TEXT NOT NULL, approved_owner_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('held_adapter_unqualified','cancelled')),
 amount_cents INTEGER NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(grant_id,idempotency_key)
);
CREATE TABLE hnd_drafts (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES hnd_grants(id), case_id TEXT NOT NULL REFERENCES hnd_cases(id),
 text TEXT NOT NULL, created_at INTEGER NOT NULL
);
