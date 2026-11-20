-- Every account gets its settings row when it is made (server/src/settings/app-settings.ts). An account made
-- before the table existed gets one here, with the columns' defaults, so the generated read always finds it.
INSERT INTO "app_settings" ("user_id") SELECT "id" FROM "users" ON CONFLICT DO NOTHING;
