-- Migration: Add links processing tables for MVP
-- Purpose: Store processed links with metadata and enable semantic search

-- Main links table with simplified schema for MVP
CREATE TABLE links (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,                    -- Cleaned/canonical URL
    original_url TEXT NOT NULL,                  -- Raw URL from Slack (with pipe formatting)
    domain TEXT NOT NULL,                       -- Extracted domain (e.g., 'arxiv.org')
    
    -- Basic metadata
    title TEXT,
    description TEXT,
    site_name TEXT,
    
    -- Processed content (core MVP features)
    summary TEXT,                               -- AI-generated summary
    word_count INTEGER DEFAULT 0,
    
    -- Processing status (simple for MVP)
    processing_status TEXT NOT NULL DEFAULT 'pending', -- pending, completed, failed
    error_message TEXT,
    
    -- Usage tracking
    message_count INTEGER DEFAULT 0,           -- How many messages reference this link
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Semantic search (MVP feature)
    summary_embedding vector(1536),            -- OpenAI text-embedding-3-small dimensions
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Junction table to track which messages contain which links
CREATE TABLE message_links (
    id SERIAL PRIMARY KEY,
    message_id TEXT NOT NULL,                   -- Reference to slack_message.id
    link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    position INTEGER,                           -- Position of link in message text
    context TEXT,                              -- Surrounding text context (~100 chars)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(message_id, link_id)
);

-- Essential indexes for MVP performance
CREATE INDEX idx_links_url ON links(url);
CREATE INDEX idx_links_domain ON links(domain);
CREATE INDEX idx_links_first_seen ON links(first_seen_at DESC);  -- Chronological display
CREATE INDEX idx_links_message_count ON links(message_count DESC);

-- Semantic search index (cosine distance for embeddings)
CREATE INDEX idx_links_summary_embedding ON links USING ivfflat (summary_embedding vector_cosine_ops)
WITH (lists = 100);

-- Message-link relationship indexes
CREATE INDEX idx_message_links_message_id ON message_links(message_id);
CREATE INDEX idx_message_links_link_id ON message_links(link_id);

-- Update trigger to maintain updated_at timestamp
CREATE OR REPLACE FUNCTION update_links_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language plpgsql;

CREATE TRIGGER trigger_links_updated_at
    BEFORE UPDATE ON links
    FOR EACH ROW
    EXECUTE FUNCTION update_links_updated_at();