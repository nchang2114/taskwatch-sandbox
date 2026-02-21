-- Migration: Rename tasks.bucket_id → tasks.container_id
-- Purpose: Align SQL schema with IDB model so quick list tasks use
--          container_id = '__quicklist__' instead of requiring a hidden goal + bucket.
--
-- Run this in Supabase SQL Editor BEFORE deploying the code changes.

-- 1. Find and drop the FK constraint from tasks.bucket_id → buckets(id)
--    (The constraint name may vary; check with \d tasks if needed)
DO $$
DECLARE
  _constraint_name text;
BEGIN
  FOR _constraint_name IN
    SELECT tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_name = 'tasks'
      AND kcu.column_name = 'bucket_id'
  LOOP
    EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', _constraint_name);
    RAISE NOTICE 'Dropped FK constraint: %', _constraint_name;
  END LOOP;
END $$;

-- 2. Rename the column
ALTER TABLE tasks RENAME COLUMN bucket_id TO container_id;

-- 3. Change type from uuid to text (to allow '__quicklist__' sentinel value)
ALTER TABLE tasks ALTER COLUMN container_id TYPE text USING container_id::text;

-- 4. Migrate existing quick list tasks: point them to '__quicklist__' instead of the hidden bucket
UPDATE tasks SET container_id = '__quicklist__'
WHERE container_id IN (
  SELECT b.id::text FROM buckets b
  JOIN goals g ON b.goal_id = g.id
  WHERE g.name = 'Quick List (Hidden)'
);

-- 5. Clean up orphaned Quick List goals (buckets cascade-delete automatically)
DELETE FROM goals WHERE name = 'Quick List (Hidden)';

-- 6. Drop old indexes that reference bucket_id and create new ones
--    (Index names may vary; drop by checking pg_indexes if needed)
DO $$
DECLARE
  _index_name text;
BEGIN
  FOR _index_name IN
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'tasks'
      AND indexdef LIKE '%bucket_id%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', _index_name);
    RAISE NOTICE 'Dropped index: %', _index_name;
  END LOOP;
END $$;

-- 7. Create new indexes on container_id
CREATE INDEX IF NOT EXISTS tasks_container_id_idx ON tasks (container_id);
CREATE INDEX IF NOT EXISTS tasks_user_container_sort_idx ON tasks (user_id, container_id, sort_index);

-- 8. Update RLS policies if they reference bucket_id
--    Check with: SELECT * FROM pg_policies WHERE tablename = 'tasks';
--    If any policy references bucket_id, update it manually.

-- Verification queries:
-- SELECT container_id, count(*) FROM tasks GROUP BY container_id ORDER BY count(*) DESC;
-- SELECT * FROM tasks WHERE container_id = '__quicklist__' LIMIT 5;
