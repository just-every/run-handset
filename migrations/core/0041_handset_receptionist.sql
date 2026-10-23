-- Caller outcomes: owner-set policy versions, one work identity per call, one
-- durable step per receiving system, exact caller charge authorization and
-- owned exceptions. Steps record "sent" before any network effect so a lost
-- response stays uncertain until readback.
CREATE TABLE hnd_rx_policy (
 version INTEGER PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)),
 owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER hnd_rx_policy_no_update BEFORE UPDATE ON hnd_rx_policy BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_rx_policy_no_delete BEFORE DELETE ON hnd_rx_policy BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE hnd_rx_outcomes (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES hnd_grants(id), case_id TEXT NOT NULL REFERENCES hnd_cases(id),
 call_id TEXT NOT NULL, language TEXT NOT NULL CHECK(language IN ('en','es')), after_hours INTEGER NOT NULL CHECK(after_hours IN (0,1)),
 policy_version INTEGER NOT NULL REFERENCES hnd_rx_policy(version), caller_name TEXT NOT NULL, caller_email TEXT NOT NULL,
 identity_basis TEXT NOT NULL, identity_reported INTEGER NOT NULL CHECK(identity_reported IN (0,1)), payment_method_ref TEXT,
 created_at INTEGER NOT NULL, UNIQUE(grant_id,call_id)
);
CREATE TABLE hnd_rx_steps (
 id TEXT PRIMARY KEY, outcome_id TEXT NOT NULL REFERENCES hnd_rx_outcomes(id),
 kind TEXT NOT NULL CHECK(kind IN ('availability','booking','deposit','crm','support','refund')),
 state TEXT NOT NULL CHECK(state IN ('pending','sent','confirmed','uncertain','rejected','held')),
 request TEXT NOT NULL CHECK(json_valid(request)), request_hash TEXT NOT NULL, external_id TEXT,
 readback TEXT CHECK(readback IS NULL OR json_valid(readback)), attempts INTEGER NOT NULL DEFAULT 0,
 amount_cents INTEGER NOT NULL DEFAULT 0 CHECK(amount_cents>=0), version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(outcome_id,kind)
);
CREATE TABLE hnd_rx_authorizations (
 id TEXT PRIMARY KEY, outcome_id TEXT NOT NULL REFERENCES hnd_rx_outcomes(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 payee TEXT NOT NULL, purpose TEXT NOT NULL, language TEXT NOT NULL, prompt TEXT NOT NULL, prompt_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('proposed','authorized','declined')), evidence TEXT CHECK(evidence IS NULL OR json_valid(evidence)),
 consumed_by TEXT UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE TABLE hnd_rx_exceptions (
 id TEXT PRIMARY KEY, outcome_id TEXT NOT NULL REFERENCES hnd_rx_outcomes(id), kind TEXT NOT NULL,
 requested TEXT NOT NULL CHECK(json_valid(requested)), request_hash TEXT NOT NULL, evidence TEXT NOT NULL CHECK(json_valid(evidence)),
 owner_id TEXT NOT NULL REFERENCES oa_operators(id), status TEXT NOT NULL CHECK(status IN ('open','approved','declined','resolved')),
 callback_due_at INTEGER NOT NULL, notification TEXT NOT NULL CHECK(notification IN ('sent','failed','uncertain')),
 decided_by TEXT REFERENCES oa_operators(id), decided_owner_version INTEGER, decided_at INTEGER, note TEXT,
 consumed_by TEXT UNIQUE, created_at INTEGER NOT NULL, UNIQUE(outcome_id,kind,request_hash)
);
