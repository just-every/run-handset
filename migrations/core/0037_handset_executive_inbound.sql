CREATE TABLE hnd_frontdesk_routing (
 id TEXT PRIMARY KEY, line_id TEXT NOT NULL UNIQUE REFERENCES hnd_frontdesk_lines(id),
 line_revision INTEGER NOT NULL, delegation_id TEXT REFERENCES hnd_delegations(id),
 endpoint_kind TEXT, endpoint_destination TEXT, endpoint_revision INTEGER,
 voicemail_url TEXT NOT NULL, max_seconds INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 revision INTEGER NOT NULL, approved_by TEXT NOT NULL, owner_version INTEGER NOT NULL
);
CREATE TABLE hnd_frontdesk_inbound (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES hnd_sources(id), call_sid TEXT NOT NULL,
 line_id TEXT NOT NULL, line_revision INTEGER NOT NULL, route_revision INTEGER,
 branch TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(source_id,call_sid)
);
