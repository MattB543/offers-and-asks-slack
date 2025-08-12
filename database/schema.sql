CREATE EXTENSION IF NOT EXISTS vector;

-- People table to store Slack users
CREATE TABLE IF NOT EXISTS people (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  most_interested_in TEXT,
  confusion TEXT,
  expertise TEXT,
  projects TEXT,
  asks TEXT,
  offers TEXT,
  slack_user_id TEXT
);

-- Skills table with embeddings
CREATE TABLE IF NOT EXISTS skills (
  id SERIAL PRIMARY KEY,
  skill TEXT NOT NULL UNIQUE,
  embedding vector(1536),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Junction table for person-skill relationships
CREATE TABLE IF NOT EXISTS person_skills (
  user_id TEXT REFERENCES people(user_id) ON DELETE CASCADE,
  skill_id INT REFERENCES skills(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, skill_id)
);

-- Weekly needs tracking table
CREATE TABLE IF NOT EXISTS weekly_needs (
  id SERIAL PRIMARY KEY,
  user_id TEXT REFERENCES people(user_id) ON DELETE CASCADE,
  need_text TEXT NOT NULL,
  need_embedding vector(1536),
  week_start DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Tracking columns for processing steps (added via migration too)
  skills_extracted TEXT[],
  similarity_candidates JSONB,
  reranked_ids TEXT[],
  reranked_candidates JSONB,
  processing_metadata JSONB,
  error TEXT
);

-- Helper suggestions tracking table
CREATE TABLE IF NOT EXISTS helper_suggestions (
  id SERIAL PRIMARY KEY,
  need_id INT REFERENCES weekly_needs(id) ON DELETE CASCADE,
  helper_user_id TEXT REFERENCES people(user_id) ON DELETE CASCADE,
  suggested_skills TEXT[],
  similarity_score FLOAT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Multi-tenant installations table for OAuth
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  team_id VARCHAR(20) NOT NULL,
  team_name VARCHAR(255),
  bot_token TEXT NOT NULL,
  bot_user_id VARCHAR(20),
  user_token TEXT,
  user_id VARCHAR(20),
  scopes JSONB DEFAULT '[]'::jsonb,
  installed_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  active BOOLEAN DEFAULT TRUE
);

-- Slack export tables
CREATE TABLE IF NOT EXISTS slack_export (
  id BIGSERIAL PRIMARY KEY,
  collection_time TIMESTAMPTZ,
  raw JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slack_channel_export (
  id BIGSERIAL PRIMARY KEY,
  export_id BIGINT NOT NULL,
  channel_id TEXT,
  channel_name TEXT NOT NULL,
  message_count INTEGER,
  thread_replies_count INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slack_message (
  id BIGSERIAL PRIMARY KEY,
  export_id BIGINT NOT NULL,
  channel_export_id BIGINT NOT NULL,
  channel_id TEXT,
  channel_name TEXT,
  ts TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  text TEXT,
  message_type TEXT,
  subtype TEXT,
  thread_ts TEXT,
  is_reply BOOLEAN NOT NULL DEFAULT FALSE,
  parent_ts TEXT,
  -- Per-message embedding for semantic search
  embedding vector(1536),
  raw JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_people_enabled ON people(enabled);
CREATE INDEX IF NOT EXISTS idx_people_slack_user_id ON people(slack_user_id);
CREATE INDEX IF NOT EXISTS idx_people_user_id ON people(user_id);
CREATE INDEX IF NOT EXISTS idx_person_skills_user_id ON person_skills(user_id);
CREATE INDEX IF NOT EXISTS idx_person_skills_skill_id ON person_skills(skill_id);
CREATE INDEX IF NOT EXISTS idx_weekly_needs_week_start ON weekly_needs(week_start);
CREATE INDEX IF NOT EXISTS idx_weekly_needs_user_id ON weekly_needs(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS slack_channel_export_unique ON slack_channel_export(export_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_slack_message_export ON slack_message(export_id);
CREATE INDEX IF NOT EXISTS idx_slack_message_channel_export ON slack_message(channel_export_id);
CREATE INDEX IF NOT EXISTS idx_slack_message_thread_ts ON slack_message(thread_ts);
CREATE UNIQUE INDEX IF NOT EXISTS slack_message_unique ON slack_message(channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(active);
CREATE INDEX IF NOT EXISTS idx_tenants_installed_at ON tenants(installed_at);
CREATE INDEX IF NOT EXISTS idx_tenants_team_id ON tenants(team_id);
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_team ON tenants(team_id);
CREATE INDEX IF NOT EXISTS idx_slack_message_channel_export ON slack_message(channel_export_id);
CREATE INDEX IF NOT EXISTS idx_slack_message_thread_ts ON slack_message(thread_ts);
CREATE UNIQUE INDEX IF NOT EXISTS slack_message_unique ON slack_message(channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(active);
CREATE INDEX IF NOT EXISTS idx_tenants_installed_at ON tenants(installed_at);
CREATE INDEX IF NOT EXISTS idx_tenants_team_id ON tenants(team_id);
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_team ON tenants(team_id);

-- Create HNSW index for vector similarity search (comment out if not needed initially)
-- CREATE INDEX IF NOT EXISTS idx_skills_embedding_hnsw ON skills USING hnsw (embedding vector_cosine_ops);
-- CREATE INDEX IF NOT EXISTS idx_needs_embedding_hnsw ON weekly_needs USING hnsw (need_embedding vector_cosine_ops);
-- CREATE INDEX IF NOT EXISTS idx_slack_message_embedding_hnsw ON slack_message USING hnsw (embedding vector_cosine_ops);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at on people table
DROP TRIGGER IF EXISTS update_people_updated_at ON people;
CREATE TRIGGER update_people_updated_at 
    BEFORE UPDATE ON people 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Channel profiles table for summaries and membership
CREATE TABLE IF NOT EXISTS slack_channel_profiles (
  channel_id TEXT PRIMARY KEY,
  channel_name TEXT,
  team_id TEXT REFERENCES tenants(team_id),
  summary TEXT,
  summary_model TEXT,
  summary_updated_at TIMESTAMPTZ,
  member_ids TEXT[] NOT NULL DEFAULT '{}',
  -- Optional generated column for convenience; comment out if unsupported
  -- member_count INT GENERATED ALWAYS AS (cardinality(member_ids)) STORED,
  members_synced_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger to auto-update updated_at on channel profiles
DROP TRIGGER IF EXISTS update_slack_channel_profiles_updated_at ON slack_channel_profiles;
CREATE TRIGGER update_slack_channel_profiles_updated_at
    BEFORE UPDATE ON slack_channel_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();