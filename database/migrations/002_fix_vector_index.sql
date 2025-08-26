-- Migration: Fix vector index for small datasets
-- The original IVFFlat index with lists=100 is too much for small datasets
-- This causes 0 results even with increased probes

-- Drop the problematic IVFFlat index
DROP INDEX IF EXISTS idx_links_summary_embedding;

-- For small datasets (< 1000 rows), don't use an index at all
-- Vector operations will use sequential scan which is actually faster
-- and more reliable for small datasets

-- Alternative: Create a simpler index for when we have more data
-- Uncomment this when you have 1000+ links:
-- CREATE INDEX idx_links_summary_embedding ON links USING ivfflat (summary_embedding vector_cosine_ops)
-- WITH (lists = 10); -- Much smaller lists value for small datasets

-- For now, let's add a comment to track this decision
COMMENT ON COLUMN links.summary_embedding IS 'Vector embeddings for semantic search. Index disabled for small datasets - will use sequential scan.';