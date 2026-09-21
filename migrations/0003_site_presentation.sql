-- Two per-site presentation settings.
--
-- offline_mode  'show' — the widget renders its offline state ("<label> is
--                        offline", leave-a-question form). The default.
--               'hide' — the widget renders nothing at all while the host is
--                        offline. It still connects, so the moment the host goes
--                        live the bubble appears without a reload.
--
-- agent_label   The name the widget uses in its copy for this site — "<label>
--               is live", "Talk to <label>". NULL falls back to "Agent", so a
--               site that never sets it gets neutral wording rather than the
--               host's personal name. The host profile's display name is no
--               longer used in visitor-facing copy; it stays the dashboard's.

ALTER TABLE sites ADD COLUMN offline_mode TEXT NOT NULL DEFAULT 'show';
ALTER TABLE sites ADD COLUMN agent_label TEXT;
