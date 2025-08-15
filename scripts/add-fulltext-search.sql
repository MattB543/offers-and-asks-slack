-- Migration: Add full-text search support to existing tables
-- Adds ts_vector columns and indexes for PostgreSQL full-text search

-- Add ts_vector column to slack_message table if it doesn't exist
ALTER TABLE slack_message 
ADD COLUMN IF NOT EXISTS ts_vector tsvector;

-- Create or update function to automatically populate ts_vector for slack_message
CREATE OR REPLACE FUNCTION update_slack_message_ts_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.ts_vector := 
        setweight(to_tsvector('english', COALESCE(NEW.text, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.user_name, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.channel_name, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update ts_vector on insert/update
DROP TRIGGER IF EXISTS slack_message_ts_vector_update ON slack_message;
CREATE TRIGGER slack_message_ts_vector_update
    BEFORE INSERT OR UPDATE ON slack_message
    FOR EACH ROW
    EXECUTE FUNCTION update_slack_message_ts_vector();

-- Populate existing slack_message records with ts_vector
UPDATE slack_message 
SET ts_vector = 
    setweight(to_tsvector('english', COALESCE(text, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(user_name, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(channel_name, '')), 'C')
WHERE ts_vector IS NULL AND text IS NOT NULL;

-- Create or update function to automatically populate ts_vector for document_embeddings
CREATE OR REPLACE FUNCTION update_document_embeddings_ts_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.ts_vector := 
        setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.section_title, '')), 'B');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update ts_vector on insert/update for document_embeddings
DROP TRIGGER IF EXISTS document_embeddings_ts_vector_update ON document_embeddings;
CREATE TRIGGER document_embeddings_ts_vector_update
    BEFORE INSERT OR UPDATE ON document_embeddings
    FOR EACH ROW
    EXECUTE FUNCTION update_document_embeddings_ts_vector();

-- Populate existing document_embeddings records with ts_vector
UPDATE document_embeddings 
SET ts_vector = 
    setweight(to_tsvector('english', COALESCE(content, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(section_title, '')), 'B')
WHERE ts_vector IS NULL AND content IS NOT NULL;

-- Create GIN indexes for full-text search performance
CREATE INDEX IF NOT EXISTS idx_slack_message_ts_vector 
ON slack_message USING gin(ts_vector);

-- The document_embeddings ts_vector index should already exist from the previous migration,
-- but create it if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_document_embeddings_ts_vector 
ON document_embeddings USING gin(ts_vector);

-- Create a function for full-text search with ranking
CREATE OR REPLACE FUNCTION search_slack_messages_fulltext(
    search_query text,
    result_limit integer DEFAULT 50
)
RETURNS TABLE(
    id integer,
    text text,
    user_name text,
    channel_name text,
    created_at timestamp,
    ts_rank real
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        sm.id,
        sm.text,
        sm.user_name,
        sm.channel_name,
        sm.created_at,
        ts_rank(sm.ts_vector, plainto_tsquery('english', search_query)) as ts_rank
    FROM slack_message sm
    WHERE sm.ts_vector @@ plainto_tsquery('english', search_query)
        AND sm.text IS NOT NULL
    ORDER BY ts_rank DESC, sm.created_at DESC
    LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;

-- Create a function for full-text search on documents
CREATE OR REPLACE FUNCTION search_documents_fulltext(
    search_query text,
    result_limit integer DEFAULT 50
)
RETURNS TABLE(
    id integer,
    content text,
    section_title text,
    document_title text,
    file_path text,
    chunk_type text,
    created_at timestamp,
    ts_rank real
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        de.id,
        de.content,
        de.section_title,
        d.title as document_title,
        d.file_path,
        de.chunk_type,
        de.created_at,
        ts_rank(de.ts_vector, plainto_tsquery('english', search_query)) as ts_rank
    FROM document_embeddings de
    JOIN documents d ON de.document_id = d.id
    WHERE de.ts_vector @@ plainto_tsquery('english', search_query)
        AND de.content IS NOT NULL
        AND de.source_type = 'document'
    ORDER BY ts_rank DESC, de.created_at DESC
    LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;

-- Add some helpful indexes for common search patterns
CREATE INDEX IF NOT EXISTS idx_slack_message_text_gin 
ON slack_message USING gin(to_tsvector('english', text));

CREATE INDEX IF NOT EXISTS idx_slack_message_created_at_desc 
ON slack_message (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_document_embeddings_created_at_desc 
ON document_embeddings (created_at DESC);

-- Update index state tracking
INSERT INTO index_state (index_type, total_documents, pending_updates) 
SELECT 'fulltext_search', 
       (SELECT COUNT(*) FROM slack_message WHERE ts_vector IS NOT NULL) +
       (SELECT COUNT(*) FROM document_embeddings WHERE ts_vector IS NOT NULL), 
       0
WHERE NOT EXISTS (
  SELECT 1 FROM index_state WHERE index_type = 'fulltext_search'
);

-- Show stats
SELECT 
    'slack_message' as table_name,
    COUNT(*) as total_rows,
    COUNT(ts_vector) as rows_with_ts_vector,
    ROUND(COUNT(ts_vector) * 100.0 / COUNT(*), 2) as percentage_complete
FROM slack_message
WHERE text IS NOT NULL

UNION ALL

SELECT 
    'document_embeddings' as table_name,
    COUNT(*) as total_rows,
    COUNT(ts_vector) as rows_with_ts_vector,
    ROUND(COUNT(ts_vector) * 100.0 / COUNT(*), 2) as percentage_complete
FROM document_embeddings
WHERE content IS NOT NULL;