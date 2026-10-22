-- Administrative intent is native installation data. It confers no carrier,
-- routing, invitation or emergency-service authority.
CREATE TABLE hnd_admin_profiles (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('user','device')),
 operator_id TEXT UNIQUE REFERENCES oa_operators(id), record_id TEXT NOT NULL REFERENCES hnd_records(id),
 identity TEXT NOT NULL, extension TEXT NOT NULL UNIQUE,
 config TEXT NOT NULL CHECK(json_valid(config)), overrides TEXT NOT NULL CHECK(json_valid(overrides)),
 template_id TEXT, template_version INTEGER, version INTEGER NOT NULL CHECK(version>0),
 updated_at INTEGER NOT NULL, UNIQUE(kind,identity),
 CHECK((kind='user' AND operator_id IS NOT NULL) OR (kind='device' AND operator_id IS NULL))
);
CREATE TABLE hnd_admin_templates (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('user','device')),
 role_scope TEXT NOT NULL CHECK(json_valid(role_scope)), settings TEXT NOT NULL CHECK(json_valid(settings)),
 version INTEGER NOT NULL CHECK(version>0), created_by TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE hnd_admin_template_history (
 template_id TEXT NOT NULL REFERENCES hnd_admin_templates(id), version INTEGER NOT NULL,
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), actor_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
 PRIMARY KEY(template_id,version)
);
CREATE TRIGGER hnd_admin_template_created AFTER INSERT ON hnd_admin_templates BEGIN
 INSERT INTO hnd_admin_template_history VALUES(NEW.id,NEW.version,json_object('name',NEW.name,'kind',NEW.kind,'roleScope',json(NEW.role_scope),'settings',json(NEW.settings)),NEW.created_by,NEW.updated_at);
END;
CREATE TRIGGER hnd_admin_template_changed AFTER UPDATE ON hnd_admin_templates BEGIN
 INSERT INTO hnd_admin_template_history VALUES(NEW.id,NEW.version,json_object('name',NEW.name,'kind',NEW.kind,'roleScope',json(NEW.role_scope),'settings',json(NEW.settings)),NEW.created_by,NEW.updated_at);
END;
CREATE TRIGGER hnd_admin_template_history_no_update BEFORE UPDATE ON hnd_admin_template_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER hnd_admin_template_history_no_delete BEFORE DELETE ON hnd_admin_template_history BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE hnd_admin_plans (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('csv','template')),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('preview','approved','applying','completed')),
 cursor INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
 approved_by TEXT, approved_version INTEGER, approved_role TEXT CHECK(approved_role IN ('owner','admin')), approved_at INTEGER, expires_at INTEGER NOT NULL
);
CREATE TABLE hnd_admin_applied_rows (
 plan_id TEXT NOT NULL REFERENCES hnd_admin_plans(id), row_number INTEGER NOT NULL,
 profile_id TEXT NOT NULL REFERENCES hnd_admin_profiles(id), applied_at INTEGER NOT NULL,
 PRIMARY KEY(plan_id,row_number)
);
CREATE TRIGGER hnd_admin_plan_content_no_update BEFORE UPDATE OF snapshot,hash,kind,created_by,created_at ON hnd_admin_plans BEGIN SELECT RAISE(ABORT,'immutable_plan'); END;
