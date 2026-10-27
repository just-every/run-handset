-- Native preparation only. No carrier, speech, email or contact authority.
CREATE TABLE hnd_contacts (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES oa_operators(id),
 visibility TEXT NOT NULL CHECK(visibility IN ('personal','company')),
 name TEXT NOT NULL, number TEXT NOT NULL, extension TEXT NOT NULL, timezone TEXT,
 suppressed INTEGER NOT NULL CHECK(suppressed IN (0,1)), held INTEGER NOT NULL CHECK(held IN (0,1)),
 sources TEXT NOT NULL CHECK(json_valid(sources)), revision INTEGER NOT NULL,
 merged_into TEXT REFERENCES hnd_contacts(id)
);
CREATE TABLE hnd_contact_grants (
 contact_id TEXT NOT NULL REFERENCES hnd_contacts(id), person_id TEXT NOT NULL REFERENCES oa_operators(id),
 person_version INTEGER NOT NULL, issuer_id TEXT NOT NULL REFERENCES oa_operators(id), issuer_version INTEGER NOT NULL,
 revision INTEGER NOT NULL, PRIMARY KEY(contact_id,person_id)
);
CREATE TABLE hnd_mailboxes (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES oa_operators(id),
 kind TEXT NOT NULL CHECK(kind IN ('personal','shared','group')), name TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE hnd_mailbox_members (
 box_id TEXT NOT NULL REFERENCES hnd_mailboxes(id), person_id TEXT NOT NULL REFERENCES oa_operators(id),
 person_version INTEGER NOT NULL, issuer_id TEXT NOT NULL REFERENCES oa_operators(id), issuer_version INTEGER NOT NULL,
 PRIMARY KEY(box_id,person_id)
);
CREATE TABLE hnd_voicemail_items (
 id TEXT PRIMARY KEY, box_id TEXT NOT NULL REFERENCES hnd_mailboxes(id), source_id TEXT NOT NULL,
 observation TEXT NOT NULL, language TEXT NOT NULL CHECK(language IN ('en','es')),
 claimant TEXT REFERENCES oa_operators(id), state TEXT NOT NULL CHECK(state IN ('open','handled')),
 revision INTEGER NOT NULL, UNIQUE(box_id,source_id)
);
CREATE TABLE hnd_voicemail_history (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES hnd_voicemail_items(id),
 actor TEXT NOT NULL, action TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER hnd_voicemail_history_no_update BEFORE UPDATE ON hnd_voicemail_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_voicemail_history_no_delete BEFORE DELETE ON hnd_voicemail_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
