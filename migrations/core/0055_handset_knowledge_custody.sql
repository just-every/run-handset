-- Native authority changes immediately remove text held by the old consent.
CREATE TRIGGER hnd_knowledge_owner_changed AFTER UPDATE OF version,role,status ON oa_operators
BEGIN
 UPDATE hnd_knowledge_sources SET body='',state='unavailable'
 WHERE owner_id=NEW.id AND body<>'' AND
 (owner_version<>NEW.version OR NEW.role<>'owner' OR NEW.status<>'active');
END;
CREATE TRIGGER hnd_knowledge_owner_removed AFTER DELETE ON oa_operators
BEGIN
 UPDATE hnd_knowledge_sources SET body='',state='unavailable'
 WHERE owner_id=OLD.id AND body<>'';
END;
