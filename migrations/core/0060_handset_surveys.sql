CREATE TABLE hnd_survey_invitations (
 id TEXT PRIMARY KEY,
 call_record_id TEXT NOT NULL REFERENCES hnd_records(id),
 case_id TEXT NOT NULL REFERENCES hnd_cases(id),
 call_id TEXT NOT NULL REFERENCES hnd_consent_calls(id),
 source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 channel TEXT NOT NULL CHECK(channel IN ('ivr','sms')),
 created_by TEXT NOT NULL,
 owner_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 permission_id TEXT REFERENCES hnd_text_permissions(id),
 text_id TEXT UNIQUE REFERENCES hnd_care_texts(id),
 eligible_at INTEGER,
 suppressed_at INTEGER,
 suppression_reason TEXT NOT NULL DEFAULT '',
 UNIQUE(call_record_id)
);
CREATE TABLE hnd_survey_responses (
 invitation_id TEXT PRIMARY KEY REFERENCES hnd_survey_invitations(id),
 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment TEXT NOT NULL DEFAULT '' CHECK(length(comment)<=1000),
 provider_event TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL
);
CREATE INDEX hnd_survey_invitations_pending ON hnd_survey_invitations(channel,expires_at);
CREATE TRIGGER hnd_survey_response_no_update BEFORE UPDATE ON hnd_survey_responses BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_survey_response_no_delete BEFORE DELETE ON hnd_survey_responses BEGIN SELECT RAISE(ABORT,'append_only'); END;
