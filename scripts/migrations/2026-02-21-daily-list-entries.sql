-- Migration: Create daily_list_entries table
-- Purpose: Persist daily list entries (task references) to Supabase for cross-device sync.
--
-- Run this in Supabase SQL Editor.

CREATE TABLE public.daily_list_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  daily_list_id text NOT NULL DEFAULT '__daily__',
  task_id text NOT NULL,
  sort_index integer NOT NULL DEFAULT 0,
  added_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_list_entries_pkey PRIMARY KEY (id)
) TABLESPACE pg_default;

CREATE INDEX daily_list_entries_user_idx ON public.daily_list_entries (user_id);
CREATE INDEX daily_list_entries_user_task_idx ON public.daily_list_entries (user_id, task_id);

-- RLS
ALTER TABLE daily_list_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own entries" ON daily_list_entries
  FOR ALL USING (auth.uid() = user_id);

-- Triggers (reuse existing helpers)
CREATE TRIGGER daily_list_entries_set_user_id
  BEFORE INSERT ON daily_list_entries
  FOR EACH ROW EXECUTE FUNCTION set_user_id();

CREATE TRIGGER daily_list_entries_updated_at
  BEFORE UPDATE ON daily_list_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Verification:
-- SELECT * FROM daily_list_entries LIMIT 5;
-- \d daily_list_entries
