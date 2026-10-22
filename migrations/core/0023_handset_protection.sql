CREATE TABLE hnd_protection_rules (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL CHECK(scope IN ('owner','personal')),
 personal_id TEXT,
 number_id TEXT REFERENCES hnd_records(id),
 channel TEXT NOT NULL CHECK(channel IN ('voice','fax','all')),
 match_kind TEXT NOT NULL CHECK(match_kind IN ('number','prefix','anonymous')),
 pattern TEXT NOT NULL,
 effect TEXT NOT NULL CHECK(effect IN ('allow','block','screen')),
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 revoked_at INTEGER,
 CHECK((scope='owner' AND personal_id IS NULL) OR (scope='personal' AND personal_id IS NOT NULL))
);
CREATE TABLE hnd_protection_routes (
 source_id TEXT PRIMARY KEY REFERENCES hnd_sources(id),
 number_id TEXT NOT NULL REFERENCES hnd_records(id),
 personal_id TEXT,
 continuation_url TEXT NOT NULL,
 emergency_url TEXT NOT NULL,
 max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 100),
 window_seconds INTEGER NOT NULL CHECK(window_seconds BETWEEN 10 AND 3600),
 attempt_cents INTEGER NOT NULL CHECK(attempt_cents BETWEEN 0 AND 100000),
 configured_by TEXT NOT NULL,
 revision INTEGER NOT NULL,
 configured_at INTEGER NOT NULL
);
CREATE TABLE hnd_protection_callbacks (
 id TEXT PRIMARY KEY,
 number_id TEXT NOT NULL REFERENCES hnd_records(id),
 caller TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 designated_by TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE hnd_protection_stops (
 id TEXT PRIMARY KEY,
 number_id TEXT NOT NULL REFERENCES hnd_records(id),
 recipient TEXT NOT NULL,
 channel TEXT NOT NULL CHECK(channel IN ('voice','fax','sms','all')),
 reason TEXT NOT NULL CHECK(reason IN ('dnc','consent_revoked')),
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 UNIQUE(number_id,recipient,channel,reason)
);
CREATE TABLE hnd_protection_attempts (
 id TEXT PRIMARY KEY,
 principal TEXT NOT NULL,
 event_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 number_id TEXT NOT NULL REFERENCES hnd_records(id),
 device_id TEXT NOT NULL,
 channel TEXT NOT NULL,
 direction TEXT NOT NULL,
 address TEXT NOT NULL,
 attempted_cents INTEGER NOT NULL,
 decision TEXT NOT NULL,
 reason TEXT NOT NULL,
 rule_id TEXT,
 occurred_at INTEGER NOT NULL,
 UNIQUE(principal,event_key)
);
CREATE INDEX hnd_protection_velocity ON hnd_protection_attempts(number_id,device_id,channel,direction,occurred_at);
CREATE TABLE hnd_protection_alerts (
 id TEXT PRIMARY KEY,
 number_id TEXT NOT NULL REFERENCES hnd_records(id),
 device_id TEXT NOT NULL,
 channel TEXT NOT NULL,
 reason TEXT NOT NULL,
 containment TEXT NOT NULL,
 attempt_id TEXT NOT NULL REFERENCES hnd_protection_attempts(id),
 created_at INTEGER NOT NULL,
 acknowledged_at INTEGER,
 acknowledged_by TEXT,
 UNIQUE(number_id,device_id,channel,reason)
);
CREATE TRIGGER hnd_protection_attempts_no_update BEFORE UPDATE ON hnd_protection_attempts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_protection_attempts_no_delete BEFORE DELETE ON hnd_protection_attempts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_protection_stops_no_update BEFORE UPDATE ON hnd_protection_stops BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_protection_stops_no_delete BEFORE DELETE ON hnd_protection_stops BEGIN SELECT RAISE(ABORT,'append_only'); END;
ALTER TABLE hnd_protection_alerts ADD COLUMN released_at INTEGER;
ALTER TABLE hnd_protection_alerts ADD COLUMN released_by TEXT;
