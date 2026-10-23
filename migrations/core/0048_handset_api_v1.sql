CREATE TABLE hnd_api_idempotency (
 grant_id TEXT NOT NULL REFERENCES hnd_grants(id), key TEXT NOT NULL,
 request_hash TEXT NOT NULL, response TEXT NOT NULL CHECK(json_valid(response)), created_at INTEGER NOT NULL,
 PRIMARY KEY(grant_id,key)
);
CREATE TABLE hnd_api_rate (
 grant_id TEXT NOT NULL REFERENCES hnd_grants(id), window INTEGER NOT NULL, calls INTEGER NOT NULL,
 PRIMARY KEY(grant_id,window)
);
