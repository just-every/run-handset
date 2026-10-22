-- Versioned imported licensed results: attestations never substitute for these rows.
CREATE TABLE hnd_dialer_extracts (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('national','state','reassigned')),
 jurisdiction TEXT NOT NULL, published_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 source_reference TEXT NOT NULL, evidence_id TEXT NOT NULL REFERENCES hnd_records(id),
 digest TEXT NOT NULL, approved_by TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE hnd_dialer_extract_rows (
 extract_id TEXT NOT NULL REFERENCES hnd_dialer_extracts(id), recipient TEXT NOT NULL,
 consent_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('clear','blocked','reassigned','unknown')),
 PRIMARY KEY(extract_id,recipient,consent_id)
);
CREATE TABLE hnd_dialer_state_rules (
 jurisdiction TEXT PRIMARY KEY, start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL,
 max_attempts INTEGER NOT NULL, window_hours INTEGER NOT NULL, written_modes TEXT NOT NULL,
 evidence_id TEXT NOT NULL REFERENCES hnd_records(id), review_at INTEGER NOT NULL,
 revision INTEGER NOT NULL, approved_by TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL
);
CREATE TABLE hnd_dialer_approver_scopes (
 operator_id TEXT PRIMARY KEY REFERENCES oa_operators(id), source_ids TEXT NOT NULL, queue_ids TEXT NOT NULL,
 budget_cents INTEGER NOT NULL, standing INTEGER NOT NULL CHECK(standing IN (0,1)),
 review_at INTEGER NOT NULL, revision INTEGER NOT NULL, approved_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL, revoked_at INTEGER
);
