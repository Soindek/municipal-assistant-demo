-- Store the sources the answer actually cited (the "Források" shown to the user),
-- so manual review can check "did it cite the right decree?" without resolving
-- chunk ids by hand. Shape: Source[] (documentTitle, category, sourceUrl, …).
ALTER TABLE query_log ADD COLUMN IF NOT EXISTS sources JSONB;
