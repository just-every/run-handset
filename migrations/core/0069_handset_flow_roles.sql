ALTER TABLE hnd_custom_roles ADD COLUMN flow_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(flow_ids));
