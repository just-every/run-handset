-- Explicit native recipients and content bindings; no inferred sending consent.
CREATE TABLE hnd_vm_policy (
 box_id TEXT PRIMARY KEY REFERENCES hnd_mailboxes(id),
 revision INTEGER NOT NULL, link_only INTEGER NOT NULL CHECK(link_only IN (0,1))
);
CREATE TABLE hnd_vm_settings (
 id TEXT PRIMARY KEY, box_id TEXT NOT NULL REFERENCES hnd_mailboxes(id),
 person_id TEXT NOT NULL REFERENCES oa_operators(id), person_version INTEGER NOT NULL,
 recipient TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 box_revision INTEGER NOT NULL, policy_revision INTEGER NOT NULL, revision INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('attachment_text','text','link')),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), link_seconds INTEGER NOT NULL,
 UNIQUE(box_id,person_id)
);
CREATE TABLE hnd_vm_content (
 item_id TEXT PRIMARY KEY REFERENCES hnd_voicemail_items(id),
 recording_id TEXT NOT NULL REFERENCES hnd_records(id), transcript_id TEXT NOT NULL REFERENCES hnd_transcripts(id),
 source_id TEXT NOT NULL REFERENCES hnd_sources(id), source_revision INTEGER NOT NULL
);
CREATE TABLE hnd_vm_jobs (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES hnd_voicemail_items(id),
 setting_id TEXT NOT NULL REFERENCES hnd_vm_settings(id), setting_revision INTEGER NOT NULL,
 due_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','preparing','sending','accepted','development','uncertain','failed','suppressed')),
 reason TEXT, link_id TEXT NOT NULL UNIQUE,
 UNIQUE(item_id,setting_id,setting_revision)
);
CREATE INDEX hnd_vm_due ON hnd_vm_jobs(state,due_at);
CREATE TABLE hnd_vm_links (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES hnd_vm_jobs(id),
 expires_at INTEGER NOT NULL, revoked_at INTEGER
);
