-- Reporting labels remain separate from advertising platform claims.
ALTER TABLE hnd_report_groups ADD COLUMN tracking_source TEXT NOT NULL DEFAULT 'Unattributed';
