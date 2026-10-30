-- A scope check alone never proves delivery. Private connection equality keys
-- prevent a previous endpoint or credential's success from qualifying its replacement.
ALTER TABLE hnd_delivery_checks ADD COLUMN connection_key TEXT;
ALTER TABLE hnd_delivery_checks ADD COLUMN step_id TEXT;
ALTER TABLE hnd_delivery_checks ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'not_checked'
 CHECK(delivery_state IN ('not_checked','pending','confirmed'));
ALTER TABLE hnd_delivery_checks ADD COLUMN delivery_started_at INTEGER;
CREATE INDEX hnd_delivery_checks_receipt ON hnd_delivery_checks(connector,target,mapping_version,connection_key,step_id,delivery_state,checked_at);
