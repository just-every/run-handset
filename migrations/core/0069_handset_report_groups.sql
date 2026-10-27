-- Reporting assignments are explicit owner-maintained labels, independent of staff teams.
CREATE TABLE hnd_report_groups (
 number TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 team TEXT NOT NULL CHECK(length(trim(team)) BETWEEN 1 AND 200),
 location TEXT NOT NULL CHECK(length(trim(location)) BETWEEN 1 AND 200),
 actor_id TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(number,revision)
);
CREATE TRIGGER hnd_report_groups_no_update BEFORE UPDATE ON hnd_report_groups BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_report_groups_no_delete BEFORE DELETE ON hnd_report_groups BEGIN SELECT RAISE(ABORT,'append_only'); END;
