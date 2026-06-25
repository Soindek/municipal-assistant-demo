-- Feedback details for query_log. The SMALLINT `feedback` column (−1 / +1)
-- already exists in 001_init.sql; add an optional free-text comment and a
-- timestamp of when the feedback was given.
ALTER TABLE query_log ADD COLUMN IF NOT EXISTS feedback_comment TEXT;
ALTER TABLE query_log ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ;
