ALTER TABLE hnd_drafts ADD COLUMN prepared_by TEXT CHECK(prepared_by IS NULL OR json_valid(prepared_by));
