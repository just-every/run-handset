ALTER TABLE hnd_frontdesk_inbound ADD COLUMN snapshot TEXT NOT NULL DEFAULT '{}';
ALTER TABLE hnd_frontdesk_inbound ADD COLUMN answered_call_sid TEXT;
ALTER TABLE hnd_frontdesk_inbound ADD COLUMN bridge_authorized_at INTEGER;
