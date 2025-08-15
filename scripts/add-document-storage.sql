-- Migration: Add document storage and embedding tables
-- This extends the existing schema to support Drive document processing

-- Documents table for tracking source documents
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  document_id VARCHAR(255) UNIQUE NOT NULL, -- Based on filename/path
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  original_file_path TEXT, -- From the "Original file:" metadata
  
  -- Document metadata
  content_hash VARCHAR(64), -- For detecting changes
  total_chunks INTEGER DEFAULT 0,
  processing_status VARCHAR(20) DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
  error_message TEXT,
  
  -- Document summary
  summary TEXT,
  summary_embedding vector(1536),
  
  -- Additional metadata from document parsing
  metadata JSONB DEFAULT '{}',
  keywords TEXT[],
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP
);

-- Enhanced embeddings table for hierarchical document chunks
CREATE TABLE IF NOT EXISTS document_embeddings (
  id SERIAL PRIMARY KEY,
  
  -- Content and embedding
  content TEXT NOT NULL,
  content_hash VARCHAR(64), -- For deduplication
  embedding vector(1536),
  embedding_model VARCHAR(50) DEFAULT 'text-embedding-3-small',
  
  -- Source identification
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('slack', 'document', 'hybrid')),
  source_id VARCHAR(255) NOT NULL, -- Document ID or Slack message ID
  
  -- Hierarchical relationships for documents
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  parent_chunk_id INTEGER REFERENCES document_embeddings(id),
  root_document_id INTEGER REFERENCES documents(id),
  
  -- Chunk positioning and hierarchy
  chunk_index INTEGER,
  chunk_level INTEGER DEFAULT 0, -- 0=doc summary, 1=section, 2=paragraph
  total_chunks_in_document INTEGER,
  
  -- Document-specific metadata
  section_title TEXT,
  hierarchy_level INTEGER, -- H1, H2, H3 etc for markdown headers
  chunk_type VARCHAR(20) DEFAULT 'semantic' CHECK (chunk_type IN ('semantic', 'structural', 'summary')),
  
  -- Rich metadata (JSONB for flexibility)
  metadata JSONB DEFAULT '{}',
  
  -- Search optimization
  ts_vector tsvector, -- For full-text search
  keywords TEXT[], -- For keyword matching
  
  -- Content flags
  has_tables BOOLEAN DEFAULT FALSE,
  has_code BOOLEAN DEFAULT FALSE,
  has_links BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_documents_document_id ON documents(document_id);
CREATE INDEX IF NOT EXISTS idx_documents_processing_status ON documents(processing_status);
CREATE INDEX IF NOT EXISTS idx_documents_summary_embedding ON documents USING hnsw (summary_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_documents_keywords_gin ON documents USING gin(keywords);

CREATE INDEX IF NOT EXISTS idx_doc_embeddings_embedding ON document_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_source_type ON document_embeddings(source_type);
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_document_id ON document_embeddings(document_id);
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_parent_chunk ON document_embeddings(parent_chunk_id);
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_chunk_level ON document_embeddings(chunk_level);
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_metadata_gin ON document_embeddings USING gin(metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_ts_vector ON document_embeddings USING gin(ts_vector);
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_keywords_gin ON document_embeddings USING gin(keywords);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_document_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to automatically update updated_at
DROP TRIGGER IF EXISTS update_documents_updated_at ON documents;
CREATE TRIGGER update_documents_updated_at 
    BEFORE UPDATE ON documents 
    FOR EACH ROW 
    EXECUTE FUNCTION update_document_updated_at_column();

DROP TRIGGER IF EXISTS update_document_embeddings_updated_at ON document_embeddings;
CREATE TRIGGER update_document_embeddings_updated_at 
    BEFORE UPDATE ON document_embeddings 
    FOR EACH ROW 
    EXECUTE FUNCTION update_document_updated_at_column();

-- Create a view for easy querying of document chunks with their parent document info
CREATE OR REPLACE VIEW document_chunks_with_metadata AS
SELECT 
    de.id,
    de.content,
    de.embedding,
    de.chunk_index,
    de.chunk_level,
    de.section_title,
    de.hierarchy_level,
    de.chunk_type,
    de.keywords,
    de.has_tables,
    de.has_code,
    de.has_links,
    de.metadata as chunk_metadata,
    
    -- Document information
    d.document_id,
    d.title as document_title,
    d.file_path,
    d.summary as document_summary,
    d.metadata as document_metadata,
    
    -- Parent chunk information (for hierarchical retrieval)
    parent.content as parent_content,
    parent.section_title as parent_section_title,
    
    de.created_at
FROM document_embeddings de
JOIN documents d ON de.document_id = d.id
LEFT JOIN document_embeddings parent ON de.parent_chunk_id = parent.id
WHERE de.source_type = 'document';

-- Add document processing tracking to existing index_state table
-- Only insert if not already exists (check manually since there's no unique constraint on index_type)
INSERT INTO index_state (index_type, total_documents, pending_updates) 
SELECT 'document_embeddings', 0, 0
WHERE NOT EXISTS (
  SELECT 1 FROM index_state WHERE index_type = 'document_embeddings'
);