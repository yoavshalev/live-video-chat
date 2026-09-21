-- Root domains replace exact origins as the embed allow-list.
--
-- `allowed_origins` held exact origins ("https://www.example.com"), which meant
-- every subdomain and the www/apex pair had to be listed separately or the
-- widget silently refused to load. `allowed_domains` holds roots
-- ("example.com"), each covering itself and any subdomain — matching rules in
-- src/shared/domains.ts, tests in test/domains.test.ts.
--
-- No backfill here. SQL cannot sensibly reduce "http://localhost:5173" and
-- "https://www.example.com" to roots, so src/lib/sites.ts derives domains from
-- the old column at read time whenever the new one is empty. The first edit
-- through the dashboard writes the new column and the fallback stops applying.
-- The old column stays; dropping it buys nothing and removes the safety net.

ALTER TABLE sites ADD COLUMN allowed_domains TEXT NOT NULL DEFAULT '[]';
