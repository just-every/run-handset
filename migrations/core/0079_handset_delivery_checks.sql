-- Retained read-scope observations contain mapping identities, never credentials or remote payloads.
CREATE TABLE hnd_delivery_checks (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 connector TEXT NOT NULL, target TEXT NOT NULL, mapping_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('available','credential_refused','scope_removed','unavailable','unconfigured','not_checked')),
 reason TEXT NOT NULL, checked_at INTEGER NOT NULL
);
CREATE INDEX hnd_delivery_checks_target ON hnd_delivery_checks(connector,target,sequence);
