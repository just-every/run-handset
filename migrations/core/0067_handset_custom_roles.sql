CREATE TABLE hnd_custom_roles (
 id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision>0),
 name TEXT NOT NULL,
 capabilities TEXT NOT NULL CHECK(json_valid(capabilities)),
 prompt_ids TEXT NOT NULL CHECK(json_valid(prompt_ids)),
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE hnd_custom_role_members (
 role_id TEXT NOT NULL REFERENCES hnd_custom_roles(id),
 person_id TEXT NOT NULL REFERENCES oa_operators(id),
 person_version INTEGER NOT NULL,
 role_revision INTEGER NOT NULL,
 PRIMARY KEY(role_id,person_id)
);
