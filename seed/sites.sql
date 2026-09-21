-- Seed data for a FRESH database. Safe to re-run on one: every insert is
-- OR REPLACE on a primary key.
--
-- ⚠️ Do NOT re-run against production once sites have been edited through the
-- dashboard. OR REPLACE would overwrite any domain you added there. The
-- dashboard's Embed tab is the source of truth after first deploy; this file
-- exists so a new environment starts with something to look at.
--
-- The hosts row's id must equal ORG_ID in wrangler.jsonc. It holds the
-- organization's intro clip and the wording shown around it; agents (the people
-- who take calls) live in the agents table — see seed/dev-agent.sql for local
-- development, and `node scripts/agent.mjs add` for a real deployment.
--
-- One statement per row: wrangler's SQL file splitter does not reliably keep a
-- multi-row INSERT together.
--
-- `allowed_domains` holds ROOT domains. Each covers itself and every subdomain
-- over https, so "example.com" admits example.com, www.example.com and
-- app.example.com. "localhost" admits http://localhost on any port, for
-- `npm run dev` plus `npm run demo`; remove it from production sites.

INSERT OR REPLACE INTO hosts (id, display_name, headline, subheadline, loop_video_url, loop_poster_url, avatar_url, created_at, updated_at)
VALUES ('default', 'Our team', 'Talk to us', 'Have a question? Someone is here right now.', NULL, NULL, NULL, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR REPLACE INTO sites (id, name, allowed_origins, allowed_domains, theme, position, accent_color, custom_greeting, enabled, created_at)
VALUES ('example', 'Example site', '[]', '["example.com","localhost"]', 'auto', 'bottom-right', NULL, NULL, 1, unixepoch() * 1000);

INSERT OR REPLACE INTO sites (id, name, allowed_origins, allowed_domains, theme, position, accent_color, custom_greeting, enabled, created_at)
VALUES ('example-two', 'Second example site', '[]', '["example.org","localhost"]', 'dark', 'bottom-right', NULL, NULL, 1, unixepoch() * 1000);
