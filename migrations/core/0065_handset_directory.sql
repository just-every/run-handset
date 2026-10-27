-- Native contacts never establish caller authentication or message consent.
CREATE TABLE hnd_contacts (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0),
 scope TEXT NOT NULL CHECK(scope IN ('personal','company')), owner_id TEXT NOT NULL REFERENCES oa_operators(id),
 value TEXT NOT NULL CHECK(json_valid(value)), merged_into TEXT REFERENCES hnd_contacts(id)
);
CREATE TABLE hnd_contact_grants (
 contact_id TEXT NOT NULL REFERENCES hnd_contacts(id), operator_id TEXT NOT NULL REFERENCES oa_operators(id),
 active INTEGER NOT NULL CHECK(active IN (0,1)), PRIMARY KEY(contact_id,operator_id)
);
