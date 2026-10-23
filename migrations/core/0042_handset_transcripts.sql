CREATE TABLE hnd_transcripts (
 id TEXT PRIMARY KEY,
 recording_id TEXT NOT NULL UNIQUE REFERENCES hnd_records(id),
 source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 source_revision INTEGER NOT NULL,
 duration_ms INTEGER NOT NULL CHECK(duration_ms>0),
 state TEXT NOT NULL CHECK(state IN ('supplied','missing')),
 reason TEXT,
 original TEXT NOT NULL CHECK(json_valid(original)),
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 created_at INTEGER NOT NULL
);
CREATE TABLE hnd_transcript_access (
 id TEXT PRIMARY KEY,
 transcript_id TEXT NOT NULL REFERENCES hnd_transcripts(id),
 person_id TEXT NOT NULL REFERENCES oa_operators(id),
 person_version INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 revoked_at INTEGER,
 created_at INTEGER NOT NULL
);
CREATE INDEX hnd_transcript_access_person ON hnd_transcript_access(person_id,transcript_id);
CREATE TABLE hnd_transcript_corrections (
 transcript_id TEXT NOT NULL REFERENCES hnd_transcripts(id),
 revision INTEGER NOT NULL,
 segment_id TEXT NOT NULL,
 replacement TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(transcript_id,revision)
);
CREATE TABLE hnd_transcript_annotations (
 id TEXT PRIMARY KEY,
 transcript_id TEXT NOT NULL REFERENCES hnd_transcripts(id),
 segment_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('summary','topic','sentiment','action','promise')),
 text TEXT NOT NULL,
 owner_id TEXT REFERENCES oa_operators(id),
 due_at INTEGER,
 due_state TEXT,
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 created_at INTEGER NOT NULL
);
