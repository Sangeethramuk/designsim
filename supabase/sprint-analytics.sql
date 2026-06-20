-- ─────────────────────────────────────────────────────────────────────────────
-- Design Floor Studio — Sprint Analytics Tables
-- Run once in: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- Sprint runs — one row per full swarm execution
CREATE TABLE IF NOT EXISTS sprints (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid        NOT NULL,
  sprint_number int         NOT NULL DEFAULT 1,
  brief         text,
  iteration_note text,
  model         text,
  agent_count   int         DEFAULT 0,
  critique_score numeric(4,1),
  duration_ms   int,
  prototype_html text,       -- full generated HTML prototype (if any)
  created_at    timestamptz DEFAULT now()
);

-- Individual agent outputs — one row per agent per sprint
CREATE TABLE IF NOT EXISTS sprint_outputs (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  sprint_id     uuid        REFERENCES sprints(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL,
  agent_id      text        NOT NULL,
  agent_name    text,
  agent_role    text,
  artifact_type text,
  content       text,        -- FULL content — no truncation
  quality_score numeric(4,1),
  created_at    timestamptz DEFAULT now()
);

-- Indexes for fast querying
CREATE INDEX IF NOT EXISTS sprints_user_id_idx        ON sprints (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sprint_outputs_sprint_id_idx ON sprint_outputs (sprint_id);
CREATE INDEX IF NOT EXISTS sprint_outputs_user_id_idx  ON sprint_outputs (user_id, agent_id);

-- Row Level Security (only owner can read/write their data)
ALTER TABLE sprints        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sprint_outputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own sprints"
  ON sprints FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own sprint outputs"
  ON sprint_outputs FOR ALL USING (auth.uid() = user_id);

-- ─── Core session tables (missing from original schema) ─────────────────────

-- Per-agent chat history
CREATE TABLE IF NOT EXISTS sessions (
  user_id    uuid  NOT NULL,
  agent_id   text  NOT NULL,
  messages   jsonb,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, agent_id)
);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own sessions"
  ON sessions FOR ALL USING (auth.uid() = user_id);

-- Per-agent artifact outputs (latest per agent per user)
CREATE TABLE IF NOT EXISTS artifacts (
  user_id    uuid  NOT NULL,
  agent_id   text  NOT NULL,
  type       text,
  lang       text,
  content    text,
  agent_name text,
  timestamp  bigint,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, agent_id)
);
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own artifacts"
  ON artifacts FOR ALL USING (auth.uid() = user_id);

-- Relay log entries (append-only, ordered by id)
CREATE TABLE IF NOT EXISTS relay_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid  NOT NULL,
  from_id    text,
  from_name  text,
  to_id      text,
  preview    text,
  timestamp  bigint
);
ALTER TABLE relay_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own relay log"
  ON relay_log FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS relay_log_user_id_idx ON relay_log (user_id, id ASC);

-- Current project brief (one per user)
CREATE TABLE IF NOT EXISTS briefs (
  user_id    uuid  NOT NULL UNIQUE,
  content    text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own brief"
  ON briefs FOR ALL USING (auth.uid() = user_id);

-- User design profile (one per user, AI-built over time)
CREATE TABLE IF NOT EXISTS user_profile (
  user_id      uuid NOT NULL UNIQUE,
  profile_text text,
  updated_at   timestamptz DEFAULT now()
);
ALTER TABLE user_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own profile"
  ON user_profile FOR ALL USING (auth.uid() = user_id);

-- Custom agent config (one per user)
CREATE TABLE IF NOT EXISTS agent_config (
  user_id         uuid NOT NULL UNIQUE,
  agents_json     jsonb,
  format_map_json jsonb,
  updated_at      timestamptz DEFAULT now()
);
ALTER TABLE agent_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own agent config"
  ON agent_config FOR ALL USING (auth.uid() = user_id);

-- Cross-project memories (append-only)
CREATE TABLE IF NOT EXISTS memories (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        NOT NULL,
  brief       text,
  artifacts   jsonb,
  relay_count int         DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own memories"
  ON memories FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS memories_user_id_idx ON memories (user_id, created_at DESC);

-- ─── Optional: helper view for the history tab ────────────────────────────────
CREATE OR REPLACE VIEW sprint_summary AS
SELECT
  s.id,
  s.user_id,
  s.sprint_number,
  s.brief,
  s.iteration_note,
  s.model,
  s.agent_count,
  s.critique_score,
  s.duration_ms,
  s.created_at,
  COUNT(o.id)                          AS output_count,
  AVG(o.quality_score)                 AS avg_quality,
  ARRAY_AGG(o.agent_id ORDER BY o.created_at) AS agent_ids
FROM sprints s
LEFT JOIN sprint_outputs o ON o.sprint_id = s.id
GROUP BY s.id;
