-- Multiple agents per organization.
--
-- One deployment is one organization. Agents are the people who take calls:
-- each has their own login and their own live/offline switch, and visitors are
-- handed out round-robin among whoever is free. See src/shared/machine.ts.
--
-- password_hash is NULL in Cloudflare Access mode, where the identity provider
-- vouches for the email and no password exists here. Format otherwise:
-- "pbkdf2$<iterations>$<salt>$<hash>" — see src/lib/password.ts, and
-- scripts/agent.mjs which produces the same thing from the command line.

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'agent',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Which agent handled it. NULL on rows from before this migration and on joins
-- nobody was ever assigned to.
ALTER TABLE queue_sessions ADD COLUMN agent_id TEXT;
ALTER TABLE calls ADD COLUMN agent_id TEXT;
CREATE INDEX idx_calls_agent ON calls (agent_id, started_at DESC);
