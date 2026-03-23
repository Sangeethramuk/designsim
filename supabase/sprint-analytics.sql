-- ─────────────────────────────────────────────────────────────────────────────
-- Design Swarm Studio — Sprint Analytics Tables
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
