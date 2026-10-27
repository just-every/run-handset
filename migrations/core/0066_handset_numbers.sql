CREATE TABLE hnd_number_quotes (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, e164 TEXT NOT NULL, country TEXT NOT NULL,
 kind TEXT NOT NULL, monthly_usd TEXT NOT NULL, capabilities TEXT NOT NULL CHECK(json_valid(capabilities)),
 owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE hnd_number_inventory (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, quote_id TEXT NOT NULL REFERENCES hnd_number_quotes(id),
 account_id TEXT NOT NULL, e164 TEXT NOT NULL UNIQUE, provider_id TEXT,
 owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL, assignment TEXT NOT NULL,
 purpose TEXT NOT NULL, campaign TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('purchasing','owned','uncertain','releasing','released','release_uncertain')),
 revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
 replacement_id TEXT REFERENCES hnd_number_inventory(id), replacement_revision INTEGER,
 release_by TEXT, release_owner_version INTEGER, release_revision INTEGER, hold_until INTEGER,
 released_at INTEGER, emergency_state TEXT NOT NULL DEFAULT 'unvalidated'
);
CREATE TRIGGER hnd_number_source_release_guard BEFORE INSERT ON hnd_sources
WHEN EXISTS (SELECT 1 FROM hnd_number_inventory i JOIN hnd_records r ON json_extract(r.data,'$.e164')=i.e164
 WHERE r.id=NEW.number_id AND (i.state IN ('releasing','released','release_uncertain') OR i.hold_until IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'number_release_protected'); END;
CREATE TRIGGER hnd_number_source_reconsent_guard BEFORE UPDATE ON hnd_sources
WHEN NEW.revoked_at IS NULL AND EXISTS (SELECT 1 FROM hnd_number_inventory i JOIN hnd_records r ON json_extract(r.data,'$.e164')=i.e164
 WHERE r.id=NEW.number_id AND (i.state IN ('releasing','released','release_uncertain') OR i.hold_until IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'number_release_protected'); END;
