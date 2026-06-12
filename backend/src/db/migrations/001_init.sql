-- 001_init — alap séma (BRIEF 6. pont).
-- Egy-bérlős telepítés: NINCS tenant_id (lásd BRIEF 6.).
-- Az embedding dimenziója a modellhez kötött: text-embedding-3-small = 1536.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id            BIGSERIAL PRIMARY KEY,
  source_name   TEXT NOT NULL,            -- melyik adapter (pl. 'wordpress-accordion')
  external_id   TEXT NOT NULL,            -- forráson belül stabil kulcs (dedup + változásfigyelés)
  title         TEXT NOT NULL,
  category      TEXT NOT NULL,            -- TenantConfig.categories kulcsa
  source_url    TEXT NOT NULL,            -- forrásmegjelöléshez
  mime_type     TEXT,
  change_token  TEXT,                     -- ETag/Last-Modified/hash; ha NULL → mindig újra
  published_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | superseded | removed
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_name, external_id)
);

CREATE TABLE IF NOT EXISTS chunks (
  id            BIGSERIAL PRIMARY KEY,
  document_id   BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,
  content       TEXT NOT NULL,
  section_ref   TEXT,                     -- pl. '12. §'
  page_number   INT,
  token_count   INT,
  embedding     vector(1536),
  tsv           tsvector
                GENERATED ALWAYS AS (to_tsvector('hungarian', content)) STORED
);

CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

-- Minőségméréshez és későbbi finomításhoz.
CREATE TABLE IF NOT EXISTS query_log (
  id                  BIGSERIAL PRIMARY KEY,
  question            TEXT NOT NULL,
  rewritten_query     TEXT,
  answer              TEXT,
  retrieved_chunk_ids BIGINT[],
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  feedback            SMALLINT      -- pl. -1 / +1, ha a UI ad visszajelzést
);
