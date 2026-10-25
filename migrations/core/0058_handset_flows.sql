CREATE TABLE hnd_flow_versions (
 id TEXT PRIMARY KEY,
 flow_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 definition TEXT NOT NULL CHECK(json_valid(definition)),
 state TEXT NOT NULL CHECK(state IN ('draft','tested','published','retired')),
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 created_at INTEGER NOT NULL,
 UNIQUE(flow_id,version)
);
CREATE TABLE hnd_flow_publications (
 flow_id TEXT PRIMARY KEY,
 version_id TEXT NOT NULL REFERENCES hnd_flow_versions(id),
 revision INTEGER NOT NULL,
 approved_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL,
 published_at INTEGER NOT NULL
);
CREATE TABLE hnd_flow_tests (
 version_id TEXT NOT NULL REFERENCES hnd_flow_versions(id),
 path TEXT NOT NULL CHECK(json_valid(path)),
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 created_at INTEGER NOT NULL
);
