-- Preserve existing source IDs and all linked evidence while allowing separate
-- consent revisions for each selected native number within a carrier account.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE hnd_sources_next (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, number_id TEXT NOT NULL REFERENCES hnd_records(id),
 owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL, revision INTEGER NOT NULL,
 revoked_at INTEGER, created_at INTEGER NOT NULL,
 UNIQUE(account_id,number_id,revision)
);
INSERT INTO hnd_sources_next SELECT * FROM hnd_sources;
DROP TABLE hnd_sources;
ALTER TABLE hnd_sources_next RENAME TO hnd_sources;
PRAGMA defer_foreign_keys = OFF;
