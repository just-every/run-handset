CREATE TABLE hnd_quality_teams (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE hnd_quality_grants (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES hnd_quality_teams(id),
 person_id TEXT NOT NULL, person_version INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('agent','supervisor')),
 private_notes INTEGER NOT NULL CHECK(private_notes IN (0,1)),
 can_export INTEGER NOT NULL CHECK(can_export IN (0,1)),
 created_by TEXT NOT NULL, owner_version INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX hnd_quality_grants_person ON hnd_quality_grants(team_id,person_id);
CREATE TABLE hnd_quality_rubrics (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES hnd_quality_teams(id),
 revision INTEGER NOT NULL, criteria TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(team_id,revision)
);
CREATE TABLE hnd_quality_reviews (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES hnd_quality_teams(id),
 call_id TEXT NOT NULL REFERENCES hnd_records(id), recording_id TEXT NOT NULL REFERENCES hnd_records(id),
 agent_id TEXT NOT NULL, rubric_id TEXT NOT NULL REFERENCES hnd_quality_rubrics(id),
 segments TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(call_id)
);
CREATE TABLE hnd_quality_scores (
 id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES hnd_quality_reviews(id),
 supersedes_id TEXT UNIQUE REFERENCES hnd_quality_scores(id), grades TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('human_review','human_override')),
 created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX hnd_quality_original ON hnd_quality_scores(review_id) WHERE supersedes_id IS NULL;
CREATE TABLE hnd_quality_comments (
 id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES hnd_quality_reviews(id),
 score_id TEXT NOT NULL REFERENCES hnd_quality_scores(id), segment_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('coaching','self_review','employee_note')),
 body TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER hnd_quality_team_update BEFORE UPDATE ON hnd_quality_teams BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_quality_team_delete BEFORE DELETE ON hnd_quality_teams BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_quality_rubric_update BEFORE UPDATE ON hnd_quality_rubrics BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_quality_rubric_delete BEFORE DELETE ON hnd_quality_rubrics BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_quality_review_update BEFORE UPDATE ON hnd_quality_reviews BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_quality_review_delete BEFORE DELETE ON hnd_quality_reviews BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_quality_score_update BEFORE UPDATE ON hnd_quality_scores BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_quality_score_delete BEFORE DELETE ON hnd_quality_scores BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_quality_comment_update BEFORE UPDATE ON hnd_quality_comments BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_quality_comment_delete BEFORE DELETE ON hnd_quality_comments BEGIN SELECT RAISE(ABORT,'append_only'); END;
