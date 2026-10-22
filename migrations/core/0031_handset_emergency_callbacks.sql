-- Automatic post-911 windows include restricted caller IDs to this business number.
CREATE TABLE hnd_protection_emergency_settings (
 number_id TEXT PRIMARY KEY REFERENCES hnd_records(id), minutes INTEGER NOT NULL CHECK(minutes>=60),
 configured_by TEXT NOT NULL REFERENCES oa_operators(id), configured_at INTEGER NOT NULL
);
CREATE TABLE hnd_protection_emergency_windows (
 number_id TEXT PRIMARY KEY REFERENCES hnd_records(id), opened_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, attempt_id TEXT NOT NULL REFERENCES hnd_protection_attempts(id)
);
