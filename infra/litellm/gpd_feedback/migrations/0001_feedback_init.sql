-- gpd_feedback initial schema.
--
-- One row per submission. Append-only — admins read via psql / dashboard.
-- No retention policy enforced at DB level; ops decides how long to keep
-- (drop rows older than N months via a cron). client_ip stored as INET so
-- it survives IPv4 + IPv6 + shorthand forms.
--
-- Filename prefix differs from gpd_tos (`0001_init.sql`) because the
-- shared schema_migrations table tracks names — same name twice would
-- cause one runner to think the other's file was already applied.

CREATE TABLE IF NOT EXISTS gpd_feedback (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT         NOT NULL,
  token_hash_suffix TEXT    NOT NULL,
  category     TEXT         NOT NULL CHECK (category IN ('bug', 'feature', 'feedback')),
  message      TEXT         NOT NULL CHECK (length(message) BETWEEN 1 AND 8000),
  app_version  TEXT,
  user_agent   TEXT,
  client_ip    INET,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gpd_feedback_created_at
  ON gpd_feedback (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gpd_feedback_user_id
  ON gpd_feedback (user_id);

CREATE INDEX IF NOT EXISTS idx_gpd_feedback_category
  ON gpd_feedback (category);
