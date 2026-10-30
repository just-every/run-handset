-- Submission time distinguishes a lost current write from an older matching message.
ALTER TABLE hnd_message_jobs ADD COLUMN submitted_at INTEGER;
ALTER TABLE hnd_message_jobs ADD COLUMN readback_at INTEGER;
CREATE TABLE hnd_message_delivery_receipts (
 job_id TEXT NOT NULL REFERENCES hnd_message_jobs(id), provider_sid TEXT NOT NULL,
 status TEXT NOT NULL, body_hash TEXT NOT NULL, received_at INTEGER NOT NULL,
 PRIMARY KEY(job_id,provider_sid,status)
);
