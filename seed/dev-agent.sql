-- A sign-in for LOCAL DEVELOPMENT ONLY. `npm run db:seed` applies it to the
-- local database; `npm run db:seed:remote` deliberately does not.
--
--   email     dev@example.com
--   password  local-dev-password
--
-- The hash is PBKDF2-SHA256, 100 000 iterations, in the format src/lib/password.ts
-- verifies (`node scripts/agent.mjs password` produces the same thing). Never
-- load this into a deployed database: it is a published admin credential.

INSERT OR REPLACE INTO agents (id, name, email, password_hash, role, enabled, created_at, last_login_at)
VALUES ('dev', 'Dev Admin', 'dev@example.com', 'pbkdf2$100000$upP7GcA-MszPoC5m6QfRJA$XooOPDzGAzlH02KdKjUThC3sygP6grf0OEPML1g7lEA', 'admin', 1, unixepoch() * 1000, NULL);
