-- Earlier pending requests have no current author-version approval and stay closed.
ALTER TABLE hnd_prompt_recordings ADD COLUMN author_version INTEGER NOT NULL DEFAULT 0;
