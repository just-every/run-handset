-- A challenge is scoped to one verified carrier call. Terminal challenges cannot
-- issue another continuation; a new call requires a new carrier CallSid.
CREATE TABLE hnd_protection_challenges (
 id TEXT PRIMARY KEY,
 source_id TEXT NOT NULL REFERENCES hnd_sources(id),
 source_revision INTEGER NOT NULL,
 owner_id TEXT NOT NULL,
 owner_version INTEGER NOT NULL,
 account_id TEXT NOT NULL,
 number_id TEXT NOT NULL REFERENCES hnd_records(id),
 caller TEXT NOT NULL,
 called_number TEXT NOT NULL,
 call_sid TEXT NOT NULL,
 rule_id TEXT NOT NULL REFERENCES hnd_protection_rules(id),
 route_revision INTEGER NOT NULL,
 digit TEXT NOT NULL CHECK(digit GLOB '[1-9]' AND length(digit)=1),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 round INTEGER NOT NULL DEFAULT 1 CHECK(round BETWEEN 1 AND 3),
 status TEXT NOT NULL CHECK(status IN ('pending','passed','failed','expired','cancelled')),
 last_outcome TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 continued_at INTEGER,
 continuation_url TEXT,
 continued_route_revision INTEGER,
 UNIQUE(source_id,call_sid),
 CHECK((status='passed' AND continued_at IS NOT NULL AND continuation_url IS NOT NULL AND continued_route_revision IS NOT NULL)
    OR (status!='passed' AND continued_at IS NULL AND continuation_url IS NULL AND continued_route_revision IS NULL))
);
CREATE TRIGGER hnd_protection_challenge_terminal BEFORE UPDATE ON hnd_protection_challenges
 WHEN OLD.status!='pending'
 BEGIN SELECT RAISE(ABORT,'challenge_already_terminal'); END;
CREATE TRIGGER hnd_protection_challenge_no_delete BEFORE DELETE ON hnd_protection_challenges
 BEGIN SELECT RAISE(ABORT,'challenge_history_required'); END;
