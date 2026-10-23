-- Historical outcomes lack a reviewed case snapshot and cannot create new
-- effects. Their existing receipts remain readable. New work pins the case.
ALTER TABLE hnd_rx_outcomes ADD COLUMN case_version INTEGER NOT NULL DEFAULT 0;
