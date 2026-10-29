-- Originating authority is retained atomically with native held work and activity.
CREATE TABLE hnd_agent_jobs (
 job_id TEXT PRIMARY KEY REFERENCES hnd_jobs(id), identity TEXT NOT NULL CHECK(json_valid(identity)),
 idempotency_key TEXT NOT NULL
);
CREATE TABLE hnd_agent_activity (
 audit_id TEXT PRIMARY KEY REFERENCES hnd_audit(id), operation_id TEXT NOT NULL,
 agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, sponsor_id TEXT NOT NULL,
 sponsor_name TEXT NOT NULL, label TEXT NOT NULL, consent TEXT,
 approvers TEXT NOT NULL CHECK(json_valid(approvers))
);
CREATE INDEX hnd_agent_activity_operation ON hnd_agent_activity(operation_id);
CREATE TABLE hnd_agent_invocations (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, arguments TEXT NOT NULL CHECK(json_valid(arguments)),
 identity TEXT NOT NULL CHECK(json_valid(identity)), state TEXT NOT NULL CHECK(state IN ('queued','running','done')),
 result TEXT CHECK(result IS NULL OR json_valid(result)), created_at INTEGER NOT NULL
);
