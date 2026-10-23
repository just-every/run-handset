ALTER TABLE hnd_grants ADD COLUMN credential_expires_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hnd_grants ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 1;
UPDATE hnd_grants SET credential_expires_at=expires_at;
