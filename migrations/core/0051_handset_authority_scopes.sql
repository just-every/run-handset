CREATE TABLE hnd_authority_scopes (
 id TEXT PRIMARY KEY,
 operator_id TEXT NOT NULL REFERENCES oa_operators(id), operator_version INTEGER NOT NULL,
 definition TEXT NOT NULL CHECK(json_valid(definition)), permissions TEXT NOT NULL CHECK(json_valid(permissions)),
 created_by TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
);
ALTER TABLE hnd_grants ADD COLUMN scope_id TEXT REFERENCES hnd_authority_scopes(id);
ALTER TABLE hnd_approvals ADD COLUMN scope_id TEXT REFERENCES hnd_authority_scopes(id);
ALTER TABLE hnd_standing ADD COLUMN scope_id TEXT REFERENCES hnd_authority_scopes(id);
