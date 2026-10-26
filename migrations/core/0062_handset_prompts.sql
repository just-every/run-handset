CREATE TABLE hnd_prompts (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('main_attendant','menu','queue','holiday','after_hours')),
 shared INTEGER NOT NULL CHECK(shared IN (0,1)),
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 created_at INTEGER NOT NULL
);
CREATE TABLE hnd_prompt_versions (
 id TEXT PRIMARY KEY,
 prompt_id TEXT NOT NULL REFERENCES hnd_prompts(id),
 version INTEGER NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('upload','browser_recording','phone_recording','tts')),
 language TEXT NOT NULL CHECK(language IN ('en','es')),
 variant TEXT NOT NULL CHECK(variant IN ('business_hours','holiday','after_hours','always')),
 schedule TEXT NOT NULL CHECK(json_valid(schedule)),
 script TEXT,
 original_format TEXT NOT NULL,
 audio TEXT NOT NULL,
 audio_sha256 TEXT NOT NULL,
 duration_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('draft','previewed','approved')),
 author_id TEXT NOT NULL REFERENCES oa_operators(id),
 created_at INTEGER NOT NULL,
 previewed_by TEXT REFERENCES oa_operators(id),
 previewed_at INTEGER,
 approved_by TEXT REFERENCES oa_operators(id),
 approved_at INTEGER,
 UNIQUE(prompt_id,version)
);
CREATE TABLE hnd_extensions (
 extension TEXT PRIMARY KEY CHECK(length(extension) BETWEEN 3 AND 5 AND extension NOT GLOB '*[^0-9]*'),
 operator_id TEXT NOT NULL REFERENCES oa_operators(id),
 directory_name TEXT NOT NULL,
 keypad TEXT NOT NULL,
 destination TEXT NOT NULL CHECK(destination GLOB '+[1-9]*'),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 created_at INTEGER NOT NULL
);
CREATE TABLE hnd_prompt_recordings (
 id TEXT PRIMARY KEY,
 prompt_id TEXT NOT NULL REFERENCES hnd_prompts(id),
 source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 language TEXT NOT NULL CHECK(language IN ('en','es')),
 variant TEXT NOT NULL CHECK(variant IN ('business_hours','holiday','after_hours','always')),
 author_id TEXT NOT NULL REFERENCES oa_operators(id),
 destination TEXT NOT NULL,
 pin_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('awaiting_call','authenticated','recorded','refused')),
 call_sid TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 version_id TEXT REFERENCES hnd_prompt_versions(id),
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE hnd_prompt_tests (
 id TEXT PRIMARY KEY,
 flow_version_id TEXT NOT NULL REFERENCES hnd_flow_versions(id),
 source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 instant TEXT NOT NULL,
 call_sid TEXT,
 created_by TEXT NOT NULL REFERENCES oa_operators(id),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TABLE hnd_prompt_test_events (
 id TEXT PRIMARY KEY,
 test_id TEXT NOT NULL REFERENCES hnd_prompt_tests(id),
 node_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 detail TEXT NOT NULL CHECK(json_valid(detail)),
 occurred_at INTEGER NOT NULL
);
