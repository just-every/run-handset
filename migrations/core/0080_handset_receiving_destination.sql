-- An uncertain effect belongs to its original receiver, even after configuration changes.
ALTER TABLE hnd_rx_steps ADD COLUMN destination_origin TEXT;
