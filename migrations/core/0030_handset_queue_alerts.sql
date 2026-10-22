-- Durable owner-visible exceptions; emitting native instructions is not audio receipt.
CREATE TABLE hnd_queue_alerts (
 id TEXT PRIMARY KEY, queue_id TEXT NOT NULL REFERENCES hnd_queues(id),
 entry_id TEXT NOT NULL REFERENCES hnd_queue_entries(id), reason TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(entry_id,reason)
);
