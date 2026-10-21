CREATE TABLE hnd_sources (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, number_id TEXT NOT NULL REFERENCES hnd_records(id),
 owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL, revision INTEGER NOT NULL,
 revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE hnd_source_cases (
 source_id TEXT NOT NULL REFERENCES hnd_sources(id), correlation TEXT NOT NULL,
 case_id TEXT NOT NULL REFERENCES hnd_cases(id), PRIMARY KEY(source_id,correlation)
);
CREATE TABLE hnd_source_objects (
 source_id TEXT NOT NULL REFERENCES hnd_sources(id), external_id TEXT NOT NULL,
 record_id TEXT NOT NULL REFERENCES hnd_records(id), case_id TEXT NOT NULL REFERENCES hnd_cases(id),
 PRIMARY KEY(source_id,external_id)
);
CREATE TABLE hnd_source_receipts (
 source_id TEXT NOT NULL REFERENCES hnd_sources(id), event_id TEXT NOT NULL, body_hash TEXT NOT NULL,
 occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL, record_id TEXT NOT NULL REFERENCES hnd_records(id),
 PRIMARY KEY(source_id,event_id)
);
CREATE TABLE hnd_record_sources (
 record_id TEXT PRIMARY KEY REFERENCES hnd_records(id), source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 source_kind TEXT NOT NULL, source_event_id TEXT NOT NULL
);
CREATE TABLE hnd_source_pending (
 source_id TEXT NOT NULL REFERENCES hnd_sources(id), event_id TEXT NOT NULL, body_hash TEXT NOT NULL,
 parent_external_id TEXT NOT NULL, parameters TEXT NOT NULL, received_at INTEGER NOT NULL,
 PRIMARY KEY(source_id,event_id)
);
CREATE TRIGGER hnd_receipts_no_update BEFORE UPDATE ON hnd_source_receipts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_receipts_no_delete BEFORE DELETE ON hnd_source_receipts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_record_sources_no_update BEFORE UPDATE ON hnd_record_sources BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_record_sources_no_delete BEFORE DELETE ON hnd_record_sources BEGIN SELECT RAISE(ABORT,'append_only'); END;
