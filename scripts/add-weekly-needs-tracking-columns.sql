-- Add tracking columns to weekly_needs to store processing steps and outputs
-- Safe to run multiple times; each ADD COLUMN guarded by IF NOT EXISTS

BEGIN;

ALTER TABLE weekly_needs
  ADD COLUMN IF NOT EXISTS skills_extracted TEXT[],
  ADD COLUMN IF NOT EXISTS similarity_candidates JSONB,
  ADD COLUMN IF NOT EXISTS reranked_ids TEXT[],
  ADD COLUMN IF NOT EXISTS reranked_candidates JSONB,
  ADD COLUMN IF NOT EXISTS processing_metadata JSONB,
  ADD COLUMN IF NOT EXISTS error TEXT;

COMMIT;


