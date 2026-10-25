CREATE TABLE hnd_knowledge_consents (
 id TEXT PRIMARY KEY,
 source_id TEXT NOT NULL REFERENCES hnd_knowledge_sources(id),
 source_revision INTEGER NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('summary','spanish-translation')),
 owner_id TEXT NOT NULL,
 owner_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','withdrawn')),
 created_at INTEGER NOT NULL
);
CREATE TABLE hnd_knowledge_runs (
 id TEXT PRIMARY KEY,
 consent_id TEXT NOT NULL REFERENCES hnd_knowledge_consents(id),
 state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','refused')),
 output TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL
);
CREATE INDEX hnd_knowledge_consents_source ON hnd_knowledge_consents(source_id);
CREATE INDEX hnd_knowledge_runs_consent ON hnd_knowledge_runs(consent_id);
-- Authority loss and source replacement erase output in the originating write.
CREATE TRIGGER hnd_knowledge_processing_source_changed AFTER UPDATE OF revision,state,body ON hnd_knowledge_sources
WHEN NEW.revision<>OLD.revision OR NEW.state<>'active' OR NEW.body=''
BEGIN
 UPDATE hnd_knowledge_consents SET state='withdrawn' WHERE source_id=NEW.id;
END;
CREATE TRIGGER hnd_knowledge_processing_withdrawn AFTER UPDATE OF state ON hnd_knowledge_consents
WHEN NEW.state='withdrawn'
BEGIN
 UPDATE hnd_knowledge_runs SET output='',state='refused' WHERE consent_id=NEW.id;
END;
