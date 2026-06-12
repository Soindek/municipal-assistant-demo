-- 001_init — base schema (BRIEF section 6).
-- Single-tenant deployment: NO tenant_id (see BRIEF section 6).
-- The embedding dimension is tied to the model: text-embedding-3-small = 1536.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id            BIGSERIAL PRIMARY KEY,
  source_name   TEXT NOT NULL,            -- which adapter (e.g. 'wordpress-accordion')
  external_id   TEXT NOT NULL,            -- stable key within the source (dedup + change detection)
  title         TEXT NOT NULL,
  category      TEXT NOT NULL,            -- key of TenantConfig.categories
  source_url    TEXT NOT NULL,            -- for source attribution
  mime_type     TEXT,
  change_token  TEXT,                     -- ETag/Last-Modified/hash; if NULL → always re-fetch
  published_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | needs_ocr | superseded | removed
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_name, external_id)
);

CREATE TABLE IF NOT EXISTS chunks (
  id            BIGSERIAL PRIMARY KEY,
  document_id   BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,
  content       TEXT NOT NULL,
  section_ref   TEXT,                     -- e.g. '12. §'
  page_number   INT,
  token_count   INT,
  embedding     vector(1536),
  tsv           tsvector
                GENERATED ALWAYS AS (to_tsvector('hungarian', content)) STORED
);

CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

-- For quality measurement and later fine-tuning.
CREATE TABLE IF NOT EXISTS query_log (
  id                  BIGSERIAL PRIMARY KEY,
  question            TEXT NOT NULL,
  rewritten_query     TEXT,
  answer              TEXT,
  retrieved_chunk_ids BIGINT[],
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  feedback            SMALLINT      -- e.g. -1 / +1, if the UI provides feedback
);
