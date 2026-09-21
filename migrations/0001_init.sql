-- FounderLive schema.
--
-- Division of labour: the Durable Object owns *live* state (who is in line right
-- now, who is being invited, who is on a call). These tables own *history* —
-- what happened, for metrics and follow-up. Nothing here is ever read to answer
-- "who is next"; by the time a row lands it is already slightly out of date.
--
-- Times are unix milliseconds (INTEGER), matching Date.now() everywhere in the
-- code. Mixing ISO strings and epochs across a boundary is a classic source of
-- off-by-1000 bugs, so there is exactly one representation.

CREATE TABLE hosts (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  headline        TEXT NOT NULL DEFAULT '',
  subheadline     TEXT NOT NULL DEFAULT '',
  -- Served through /media/*, backed by R2. NULL renders a designed fallback
  -- rather than a broken <video>, so the widget is shippable before the clip is.
  loop_video_url  TEXT,
  loop_poster_url TEXT,
  avatar_url      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- One row per embedding site. `allowed_origins` is a JSON array of EXACT origins
-- (scheme + host + port). Origin checking is the only thing standing between this
-- Worker and a stranger embedding the widget on their own traffic, so there is no
-- wildcard support by design — see src/lib/sites.ts.
CREATE TABLE sites (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  allowed_origins TEXT NOT NULL DEFAULT '[]',
  theme           TEXT NOT NULL DEFAULT 'auto',
  position        TEXT NOT NULL DEFAULT 'bottom-right',
  accent_color    TEXT,
  custom_greeting TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

-- A visitor is a browser, not an account. `id` is the localStorage-held anonymous
-- id; there is no login and nothing here is required to be true.
CREATE TABLE visitors (
  id           TEXT PRIMARY KEY,
  first_name   TEXT,
  email        TEXT,
  company      TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- One row per turn in line, from join to whatever ended it. The status vocabulary
-- is the VisitorStatus union in src/shared/protocol.ts — keep them in step.
CREATE TABLE queue_sessions (
  id           TEXT PRIMARY KEY,
  visitor_id   TEXT NOT NULL,
  site_id      TEXT NOT NULL,
  page_url     TEXT,
  page_title   TEXT,
  referrer     TEXT,
  question     TEXT,
  joined_at    INTEGER NOT NULL,
  invited_at   INTEGER,
  connected_at INTEGER,
  ended_at     INTEGER,
  status       TEXT NOT NULL
);
CREATE INDEX idx_queue_sessions_joined ON queue_sessions (joined_at DESC);
CREATE INDEX idx_queue_sessions_site ON queue_sessions (site_id, joined_at DESC);
CREATE INDEX idx_queue_sessions_visitor ON queue_sessions (visitor_id);

-- Call METADATA only. No recording, no transcript, no content — see README
-- "Media privacy". The columns here are deliberately the complete list of what
-- this product knows about a conversation.
CREATE TABLE calls (
  id                TEXT PRIMARY KEY,
  visitor_id        TEXT NOT NULL,
  site_id           TEXT NOT NULL,
  queue_session_id  TEXT NOT NULL,
  realtime_room_id  TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  duration_seconds  INTEGER,
  disconnect_reason TEXT
);
CREATE INDEX idx_calls_started ON calls (started_at DESC);
CREATE INDEX idx_calls_site ON calls (site_id, started_at DESC);

-- The offline path. Someone arrived, the host was not there, and they still had
-- a question. This table is the reason going offline is not a dead end.
CREATE TABLE offline_messages (
  id         TEXT PRIMARY KEY,
  site_id    TEXT NOT NULL,
  visitor_id TEXT,
  name       TEXT NOT NULL,
  email      TEXT,
  message    TEXT NOT NULL,
  page_url   TEXT,
  created_at INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX idx_offline_messages_created ON offline_messages (created_at DESC);

-- First-party funnel events. Written after the response is already on its way to
-- the client — analytics must never be in the path of a queue update.
CREATE TABLE analytics_events (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  site_id    TEXT,
  visitor_id TEXT,
  page_url   TEXT,
  props      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_analytics_created ON analytics_events (created_at DESC);
CREATE INDEX idx_analytics_name ON analytics_events (name, created_at DESC);
