-- ─────────────────────────────────────────────────────────────────────────────
-- Design Floor Studio — Missing Tables Migration
-- Run in: Supabase Dashboard → SQL Editor
-- Safe to run multiple times (IF NOT EXISTS on all objects)
-- ─────────────────────────────────────────────────────────────────────────────

-- Per-agent chat history
CREATE TABLE IF NOT EXISTS sessions (
  user_id    uuid  NOT NULL,
  agent_id   text  NOT NULL,
  messages   jsonb,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, agent_id)
);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='sessions' AND policyname='Users manage their own sessions') THEN
    CREATE POLICY "Users manage their own sessions" ON sessions FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;

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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='artifacts' AND policyname='Users manage their own artifacts') THEN
    CREATE POLICY "Users manage their own artifacts" ON artifacts FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;

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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='relay_log' AND policyname='Users manage their own relay log') THEN
    CREATE POLICY "Users manage their own relay log" ON relay_log FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS relay_log_user_id_idx ON relay_log (user_id, id ASC);

-- Current project brief (one per user)
CREATE TABLE IF NOT EXISTS briefs (
  user_id    uuid  NOT NULL UNIQUE,
  content    text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE briefs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='briefs' AND policyname='Users manage their own brief') THEN
    CREATE POLICY "Users manage their own brief" ON briefs FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;

-- User design profile (one per user, AI-built over time)
CREATE TABLE IF NOT EXISTS user_profile (
  user_id      uuid NOT NULL UNIQUE,
  profile_text text,
  updated_at   timestamptz DEFAULT now()
);
ALTER TABLE user_profile ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_profile' AND policyname='Users manage their own profile') THEN
    CREATE POLICY "Users manage their own profile" ON user_profile FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;

-- Custom agent config (one per user)
CREATE TABLE IF NOT EXISTS agent_config (
  user_id         uuid NOT NULL UNIQUE,
  agents_json     jsonb,
  format_map_json jsonb,
  updated_at      timestamptz DEFAULT now()
);
ALTER TABLE agent_config ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_config' AND policyname='Users manage their own agent config') THEN
    CREATE POLICY "Users manage their own agent config" ON agent_config FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;

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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='memories' AND policyname='Users manage their own memories') THEN
    CREATE POLICY "Users manage their own memories" ON memories FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS memories_user_id_idx ON memories (user_id, created_at DESC);
