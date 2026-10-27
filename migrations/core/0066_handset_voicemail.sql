-- Supplied-text observations are preparatory records, never carrier capture receipts.
CREATE TABLE hnd_voicemail_boxes (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('personal','shared')),
 owner_id TEXT NOT NULL REFERENCES oa_operators(id)
);
CREATE TABLE hnd_voicemail_members (
 box_id TEXT NOT NULL REFERENCES hnd_voicemail_boxes(id), operator_id TEXT NOT NULL REFERENCES oa_operators(id),
 active INTEGER NOT NULL CHECK(active IN (0,1)), PRIMARY KEY(box_id,operator_id)
);
CREATE TABLE hnd_voicemail_items (
 id TEXT PRIMARY KEY, box_id TEXT NOT NULL REFERENCES hnd_voicemail_boxes(id), source_id TEXT NOT NULL,
 transcript TEXT NOT NULL, language TEXT NOT NULL CHECK(language IN ('en','es')),
 assigned_to TEXT REFERENCES oa_operators(id), state TEXT NOT NULL CHECK(state IN ('open','handled')),
 revision INTEGER NOT NULL CHECK(revision>0), actor_id TEXT NOT NULL REFERENCES oa_operators(id), updated_at INTEGER NOT NULL,
 UNIQUE(box_id,source_id)
);
CREATE TABLE hnd_voicemail_history (
 item_id TEXT NOT NULL REFERENCES hnd_voicemail_items(id), revision INTEGER NOT NULL,
 state TEXT NOT NULL, assigned_to TEXT, actor_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
 PRIMARY KEY(item_id,revision)
);
CREATE TRIGGER hnd_voicemail_created AFTER INSERT ON hnd_voicemail_items BEGIN
 INSERT INTO hnd_voicemail_history VALUES(NEW.id,NEW.revision,NEW.state,NEW.assigned_to,NEW.actor_id,NEW.updated_at);
END;
CREATE TRIGGER hnd_voicemail_changed AFTER UPDATE ON hnd_voicemail_items BEGIN
 INSERT INTO hnd_voicemail_history VALUES(NEW.id,NEW.revision,NEW.state,NEW.assigned_to,NEW.actor_id,NEW.updated_at);
END;
CREATE TRIGGER hnd_voicemail_history_update BEFORE UPDATE ON hnd_voicemail_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_voicemail_history_delete BEFORE DELETE ON hnd_voicemail_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
