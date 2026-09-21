-- A sign-in for LOCAL DEVELOPMENT ONLY. `npm run db:seed` applies it to the
-- local database; `npm run db:seed:remote` deliberately does not.
--
--   email     dev@example.com
--   password  local-dev-password
--
-- The hash is PBKDF2-SHA256, 300 000 iterations, in the format src/lib/password.ts
-- verifies (`node scripts/agent.mjs password` produces the same thing). Never
-- load this into a deployed database: it is a published admin credential.

INSERT OR REPLACE INTO agents (id, name, email, password_hash, role, enabled, created_at, last_login_at)
VALUES ('dev', 'Dev Admin', 'dev@example.com', 'pbkdf2$300000$C20z3rgGTvQXxxK-xQjQ4A$Mr46xIbOBaH52whM3jdTzFGS6EElkuNX7D8-vzorXV0', 'admin', 1, unixepoch() * 1000, NULL);
