ALTER TABLE hnd_care_texts ADD COLUMN submitted_at INTEGER;
ALTER TABLE hnd_care_texts ADD COLUMN readback_at INTEGER;
ALTER TABLE hnd_care_texts ADD COLUMN provider_state TEXT NOT NULL DEFAULT 'unconfirmed';
CREATE TABLE hnd_care_text_receipts (
 text_id TEXT NOT NULL REFERENCES hnd_care_texts(id),
 provider_sid TEXT NOT NULL,
 status TEXT NOT NULL,
 body_hash TEXT NOT NULL,
 received_at INTEGER NOT NULL,
 PRIMARY KEY(text_id,provider_sid,status)
);
