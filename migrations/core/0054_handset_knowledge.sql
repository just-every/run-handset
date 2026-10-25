CREATE TABLE hnd_knowledge_sources (
 id TEXT PRIMARY KEY,
 provider TEXT NOT NULL CHECK(provider IN ('notion','confluence','google-drive','upload')),
 external_id TEXT NOT NULL,
 cloud_id TEXT NOT NULL,
 title TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 source_revision TEXT NOT NULL,
 citation TEXT NOT NULL,
 body TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','unavailable','revoked','erased')),
 owner_id TEXT NOT NULL,
 owner_version INTEGER NOT NULL,
 refreshed_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
