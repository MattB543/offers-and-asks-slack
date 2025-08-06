-- SQL Script to rename slack_id to user_id throughout the database
-- This script handles table columns, foreign keys, and indexes

BEGIN;

-- Step 1: Drop dependent indexes first (to avoid conflicts during column rename)
DROP INDEX IF EXISTS idx_person_skills_slack_id;
DROP INDEX IF EXISTS idx_weekly_needs_slack_id;

-- Step 2: Rename columns in all tables
-- Note: We'll rename columns but keep constraints intact where possible

-- Rename primary key column in people table
ALTER TABLE people RENAME COLUMN slack_id TO user_id;

-- Step 3: Update foreign key columns in dependent tables
ALTER TABLE person_skills RENAME COLUMN slack_id TO user_id;
ALTER TABLE weekly_needs RENAME COLUMN slack_id TO user_id;
ALTER TABLE helper_suggestions RENAME COLUMN helper_slack_id TO helper_user_id;

-- Step 4: Recreate indexes with new column names
CREATE INDEX IF NOT EXISTS idx_person_skills_user_id ON person_skills(user_id);
CREATE INDEX IF NOT EXISTS idx_weekly_needs_user_id ON weekly_needs(user_id);

-- Step 5: Update any constraint names if they reference the old column name
-- Note: PostgreSQL automatically handles most constraint updates when columns are renamed,
-- but we'll explicitly recreate the foreign key constraints to ensure consistency

-- Drop and recreate foreign key constraints with updated names
-- (This ensures they reference the renamed columns correctly)

-- For person_skills table
ALTER TABLE person_skills 
DROP CONSTRAINT IF EXISTS person_skills_slack_id_fkey,
ADD CONSTRAINT person_skills_user_id_fkey 
    FOREIGN KEY (user_id) REFERENCES people(user_id) ON DELETE CASCADE;

-- For weekly_needs table  
ALTER TABLE weekly_needs 
DROP CONSTRAINT IF EXISTS weekly_needs_slack_id_fkey,
ADD CONSTRAINT weekly_needs_user_id_fkey 
    FOREIGN KEY (user_id) REFERENCES people(user_id) ON DELETE CASCADE;

-- For helper_suggestions table
ALTER TABLE helper_suggestions 
DROP CONSTRAINT IF EXISTS helper_suggestions_helper_slack_id_fkey,
ADD CONSTRAINT helper_suggestions_helper_user_id_fkey 
    FOREIGN KEY (helper_user_id) REFERENCES people(user_id) ON DELETE CASCADE;

-- Step 6: Update primary key constraint name for consistency (optional)
-- Note: This may not be necessary as PostgreSQL typically handles this automatically
-- ALTER TABLE person_skills DROP CONSTRAINT IF EXISTS person_skills_pkey;
-- ALTER TABLE person_skills ADD CONSTRAINT person_skills_pkey PRIMARY KEY (user_id, skill_id);

-- Step 7: Add any missing indexes that might be needed
CREATE INDEX IF NOT EXISTS idx_people_user_id ON people(user_id);
CREATE INDEX IF NOT EXISTS idx_people_slack_user_id ON people(slack_user_id);

COMMIT;

-- Verification queries (run these after the migration to verify success)
/*
-- Check table structures
\d people
\d person_skills  
\d weekly_needs
\d helper_suggestions

-- Check foreign key constraints
SELECT 
    tc.table_name, 
    tc.constraint_name, 
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name 
FROM 
    information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' 
    AND tc.table_name IN ('person_skills', 'weekly_needs', 'helper_suggestions');

-- Check indexes
SELECT schemaname, tablename, indexname, indexdef 
FROM pg_indexes 
WHERE tablename IN ('people', 'person_skills', 'weekly_needs', 'helper_suggestions')
ORDER BY tablename, indexname;
*/