-- Inbox custody and reviewed messages are separate from call-bound permissions.
CREATE TABLE hnd_message_threads (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 business TEXT NOT NULL, peer TEXT NOT NULL, owner_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
 custody TEXT NOT NULL DEFAULT 'handset' CHECK(custody IN ('handset','happytohelp')),
 updated_at INTEGER NOT NULL, UNIQUE(source_id,peer)
);
CREATE TABLE hnd_inbox_messages (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES hnd_message_threads(id),
 provider_sid TEXT NOT NULL, direction TEXT NOT NULL, body TEXT NOT NULL,
 media TEXT NOT NULL CHECK(json_valid(media)), participants TEXT NOT NULL CHECK(json_valid(participants)),
 provider_state TEXT NOT NULL, carrier_state TEXT NOT NULL, occurred_at INTEGER NOT NULL,
 UNIQUE(thread_id,provider_sid)
);
CREATE TABLE hnd_message_history (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES hnd_message_threads(id),
 event TEXT NOT NULL, actor_id TEXT, occurred_at INTEGER NOT NULL
);
CREATE TABLE hnd_message_snippets (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE hnd_message_permissions (
 id TEXT PRIMARY KEY, recipient TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose='customer-care'),
 evidence TEXT NOT NULL, approved_by TEXT NOT NULL, owner_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE hnd_message_jobs (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES hnd_message_threads(id),
 permission_id TEXT NOT NULL REFERENCES hnd_message_permissions(id), snippet_id TEXT NOT NULL REFERENCES hnd_message_snippets(id),
 body TEXT NOT NULL, media TEXT NOT NULL CHECK(json_valid(media)), due_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('draft','queued','sending','accepted','delivered','failed','uncertain','suppressed','canceled')),
 reason TEXT NOT NULL, provider_state TEXT NOT NULL DEFAULT 'not submitted', carrier_state TEXT NOT NULL DEFAULT 'unconfirmed',
 provider_sid TEXT, revision INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL, owner_version INTEGER NOT NULL, thread_revision INTEGER NOT NULL,
 policy_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL,
 UNIQUE(provider_sid)
);
CREATE INDEX hnd_message_jobs_due ON hnd_message_jobs(state,due_at);
CREATE TRIGGER hnd_message_stop AFTER INSERT ON hnd_protection_stops
 WHEN NEW.channel IN ('sms','all') OR NEW.reason='dnc'
 BEGIN
 UPDATE hnd_message_jobs SET state='suppressed',reason='Company-wide STOP or DNC',revision=revision+1
 WHERE state IN ('draft','queued') AND thread_id IN (SELECT id FROM hnd_message_threads WHERE peer=NEW.recipient);
 END;
ALTER TABLE hnd_message_threads ADD COLUMN route_kind TEXT NOT NULL DEFAULT 'programmable';
ALTER TABLE hnd_message_threads ADD COLUMN participants TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(participants));
CREATE TABLE hnd_message_group_routes (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 service_sid TEXT NOT NULL, conversation_sid TEXT NOT NULL, approved_by TEXT NOT NULL, owner_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE UNIQUE INDEX hnd_group_route_current ON hnd_message_group_routes(service_sid,conversation_sid) WHERE revoked_at IS NULL;
CREATE TRIGGER hnd_message_history_no_update BEFORE UPDATE ON hnd_message_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_message_history_no_delete BEFORE DELETE ON hnd_message_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
