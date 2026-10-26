-- Exact reviewed informational permissions never grant marketing authority.
CREATE TABLE hnd_consent_policies (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES hnd_sources(id), revision INTEGER NOT NULL,
 business_name TEXT NOT NULL, legal_configuration TEXT NOT NULL, registration_id TEXT NOT NULL,
 staff_target TEXT NOT NULL, approved_by TEXT NOT NULL, owner_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
 UNIQUE(source_id,revision)
);
CREATE TABLE hnd_consent_calls (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES hnd_sources(id), policy_id TEXT NOT NULL REFERENCES hnd_consent_policies(id),
 call_sid TEXT NOT NULL, leg_sid TEXT NOT NULL, caller TEXT NOT NULL, business TEXT NOT NULL,
 identity TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(source_id,call_sid)
);
CREATE TABLE hnd_text_permissions (
 id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES hnd_consent_calls(id),
 purpose TEXT NOT NULL CHECK(purpose IN ('one_reply','survey')), state TEXT NOT NULL CHECK(state IN ('granted','declined','reserved','consumed')),
 prompt TEXT NOT NULL, event TEXT NOT NULL CHECK(json_valid(event)), created_at INTEGER NOT NULL, consumed_at INTEGER,
 UNIQUE(call_id,purpose)
);
CREATE TABLE hnd_text_recipients (
 recipient TEXT PRIMARY KEY, timezone TEXT NOT NULL, start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL,
 approved_by TEXT NOT NULL, owner_version INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE hnd_care_texts (
 id TEXT PRIMARY KEY, permission_id TEXT NOT NULL UNIQUE REFERENCES hnd_text_permissions(id),
 body TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','sending','confirmed','uncertain','suppressed')),
 provider_sid TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL, accepted_at INTEGER, delivered_at INTEGER, deadline_at INTEGER
);
CREATE TABLE hnd_consent_outcomes (
 call_id TEXT PRIMARY KEY REFERENCES hnd_consent_calls(id), call_record_id TEXT NOT NULL REFERENCES hnd_records(id),
 missed_at INTEGER NOT NULL, task_id TEXT NOT NULL REFERENCES hnd_recovery(id), text_id TEXT REFERENCES hnd_care_texts(id), reason TEXT NOT NULL
);
CREATE TRIGGER hnd_text_permission_evidence_no_update BEFORE UPDATE OF call_id,purpose,prompt,event,created_at ON hnd_text_permissions BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_text_permission_no_delete BEFORE DELETE ON hnd_text_permissions BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE hnd_verbal_recording_permissions (
 id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES hnd_consent_calls(id), evidence TEXT NOT NULL,
 approved_by TEXT NOT NULL, owner_version INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
);
