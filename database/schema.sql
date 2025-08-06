-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- People table to store Slack users
CREATE TABLE IF NOT EXISTS people (
  user_id TEXT PRIMARY KEY,
  slack_user_id TEXT,
  display_name TEXT,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_people_enabled ON people(enabled);
CREATE INDEX IF NOT EXISTS idx_person_skills_user_id ON person_skills(user_id);
CREATE INDEX IF NOT EXISTS idx_person_skills_skill_id ON person_skills(skill_id);
CREATE INDEX IF NOT EXISTS idx_weekly_needs_week_start ON weekly_needs(week_start);
CREATE INDEX IF NOT EXISTS idx_weekly_needs_user_id ON weekly_needs(user_id);

-- Create HNSW index for vector similarity search (comment out if not needed initially)
-- CREATE INDEX IF NOT EXISTS idx_skills_embedding_hnsw ON skills USING hnsw (embedding vector_cosine_ops);
-- CREATE INDEX IF NOT EXISTS idx_needs_embedding_hnsw ON weekly_needs USING hnsw (need_embedding vector_cosine_ops);

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