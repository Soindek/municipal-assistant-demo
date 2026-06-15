> **English** · [Magyar](ARCHITECTURE.hu.md)

# Architecture — Municipal Assistant (`municipal-assistant`)

This document is for new developers: responsibilities per directory, the entry
points, and the two main flows (ingestion and query) step by step, naming which
file does what. The detailed product specification: [BRIEF.md](BRIEF.md).

## Overview

The product is an embeddable chat that answers **based on a municipality's
official documents**, with source attribution. Under the hood RAG (retrieval-augmented
generation) runs: documents are ingested once (offline pipeline), and questions
are answered with hybrid search + an LLM (online path).

The code is **tenant-agnostic**; everything municipality-specific sits behind two
"seams": the **`DocumentSource` adapter** (where documents come from) and the
**`TenantConfig`** (branding, sources, RAG parameters). The MVP tenant: Vácrátót.

The repo is an **npm workspaces** monorepo with four packages: `shared`, `config`, `backend`,
`frontend`.

## Responsibilities per directory

### `shared/` — common types (no logic)
The shared contract between frontend and backend; it contains no executable logic, only types.
- `src/dto.ts` — the chat DTOs: `ChatTurn`, `Source` (source attribution), `AskRequest`,
  and the SSE `AskEvent` union (`token` / `sources` / `done` / `error`).
- `src/document-source.ts` — the types of **seam #1**: `SourceDocument` (raw
  source descriptor), `FetchedContent` (downloaded bytes), `DocumentSource` (the `list()` +
  `fetch()` interface), `DocumentSourceFactory`, and the injected `SourceLogger`.
- `src/tenant-config.ts` — the type of **seam #2**: `TenantConfig` (branding, embed
  origins, categories, `categoryKeywords`, sources, RAG parameters, limits) and
  the `SourceDescriptor`.

### `config/` — tenant loader (seam #2)
- `src/schema.ts` — the zod schema of `TenantConfig` (validates the finished config after merge).
- `src/default.ts` — sensible Hungarian municipal defaults + the **system prompt template**
  (hallucination prohibition, citation rule).
- `src/deep-merge.ts` — `default <- tenant` deep merge.
- `src/tenants/vacratot.ts` — Vácrátót's concrete config (categories, sources,
  models: `gpt-4.1-mini` + `text-embedding-3-small`).
- `src/index.ts` — `loadTenantConfig(id)`: static tenant registry → merge → zod validation.

### `backend/` — API, ingestion, DB, RAG, OCR
- `src/server.ts` — **the entry point of the HTTP server** (see below).
- `src/env.ts` — zod validation of the environment variables; loads `.env` from the repo root.
- `src/paths.ts` — the repo root path (for resolving `.env` and the upload/cache directories).
- `src/logger.ts` — simple console logger (the implementation of `SourceLogger`).
- `src/db/`
  - `pool.ts` — shared PostgreSQL connection pool (`DATABASE_URL`).
  - `migrate.ts` — lightweight migration runner (numbered `.sql` files, `schema_migrations`).
  - `migrations/001_init.sql` — the schema: `documents`, `chunks` (`vector(1536)` + Hungarian
    `tsvector`), `query_log`; HNSW + GIN indexes.
  - `repositories/documents.ts` — `findByExternalId` (change detection), `upsertDocument`
    (with status), `supersedeOtherSources` (an authoritative source overrides the others in a category).
  - `repositories/chunks.ts` — `replaceChunks` (delete + insert in a transaction),
    `deleteChunksForDocument`, vector literal construction.
  - `repositories/query-log.ts` — `insertQueryLog` (for quality measurement).
- `src/llm/` — **swappable** LLM/embedding layer.
  - `types.ts` — `EmbeddingClient`, `ChatClient` (`streamChat` + `complete`) interfaces.
  - `openai.ts` — OpenAI implementation (the key EXCLUSIVELY from env).
  - `index.ts` — `createLlmClients(config)`: builds clients from the config's model names.
- `src/ingestion/` — **the ingestion pipeline** (see the flow below).
  - `run.ts` — the **entry point** of ingestion (CLI: `seed`/`reindex`).
  - `registry.ts` — adapter name → factory mapping (wiring of seam #1).
  - `pipeline.ts` — the generic, source-agnostic pipeline (`ingestSource`).
  - `extract.ts` — PDF (pdfjs) and plain text extraction; flags if it "looks scanned".
  - `ocr.ts` — scanned PDF → OCR: pdfjs render with `@napi-rs/canvas` → `tesseract.js` (Hungarian).
  - `chunk.ts` — `§`-aware chunking with overlap.
  - `embed-text.ts` — the embedding input: document title + chunk (context for search).
  - `categorize.ts` — content-based categorization (`categoryKeywords` from the config).
  - `recategorize.ts`, `reembed.ts` — maintenance scripts (recategorizing /
    re-embedding existing documents, without re-downloading).
  - `sources/` — **the adapters (seam #1)**, each a `DocumentSource`:
    - `manual-upload.ts` — reads from a local directory (`data/uploads/`) (quick test).
    - `dlp-library.ts` — the **curated** Document Library Pro listing of
      `vacratot.hu/dokumentumok` (admin-ajax), with real categories and external links.
    - `njt-decrees.ts` — the **in-force** municipal decrees + reasonings +
      annexes from the National Legislation Database.
    - `wordpress-accordion.ts` — old WP REST media solution (stays in the registry, but the
      Vácrátót config now uses `dlp-library`).
- `src/retrieval/` — search and prompt assembly.
  - `search.ts` — `hybridSearch`: semantic (pgvector cosine) + Hungarian full-text
    (GIN, `ts_rank` length-norm) with RRF fusion, recency and category weighting; only
    `status='active'`. `authoritativeShortlist`: guaranteed authoritative candidate (`rendeletek`/
    `oldalak`) with filtered-KNN (raised `hnsw.ef_search`) + title match.
  - `prompt.ts` — system prompt, `[Forrás N]` context block, follow-up question rewrite
    (`rewriteFollowUp`), keyphrase extraction (`extractKeyphrase`), authority-aware
    rerank (`rerankChunks`), filtering to the used sources (`selectUsedChunks`) + deduplicated
    `Source[]` (`buildSources`).
- `src/api/` — the HTTP layer.
  - `app.ts` — `createApp(deps)`: assembling middleware + routes.
  - `deps.ts` — `ApiDeps` (config + LLM clients + env, built once at startup).
  - `middleware.ts` — `corsAndCsp` (only the allowed origins), `rateLimit` (IP-based).
  - `sse.ts` — SSE headers + `sendEvent` (writing out a typed `AskEvent`).
  - `handlers.ts` — the endpoints: `health`, `config`, **`ask`** (the full RAG path), `reindex`.

### `frontend/` — Angular 21 chat UI
Embeddable (iframe), zoneless + signals. Loads branding from `GET /api/config`.
- `src/app/api.ts` — `AssistantApi`: `getConfig()` + `ask()` (consumes the SSE stream of
  POST `/api/ask` via `fetch` + `ReadableStream`).
- `src/app/app.ts` / `app.html` / `app.css` — the chat component (messages as signals,
  streamed answer, sources, iframe auto-height via `postMessage`).
- `proxy.conf.json` — proxies `/api` to the backend during dev.

## Entry points

- **Backend startup:** `backend/src/server.ts` → `main()`: reads the env
  (`getEnv`), loads the tenant config (`loadTenantConfig(env.TENANT_ID)`), builds the
  LLM clients (`createLlmClients`), creates the Express app (`createApp`), and
  `app.listen(PORT)`. (Start: `npm run dev`.)
- **`/api/ask` (the query):** `backend/src/api/handlers.ts` → `createAskHandler`.
- **Ingestion:** `backend/src/ingestion/run.ts` → `run()` (CLI: `npm run seed` /
  `npm run reindex [-- --source=<adapter>]`).
- **DB schema:** `backend/src/db/migrate.ts` (`npm run migrate`).
- **Frontend:** `frontend/src/main.ts` → `App` component (`npm run dev:frontend`).

## Data model (in a nutshell)

A `documents` row is one source document (title, `source_name`, `external_id`,
`category`, `source_url`, `status`, `change_token`). A `chunks` row is one
text fragment from the document: `content` (clean text), `embedding vector(1536)`,
`tsv` (Hungarian full-text), `section_ref` (e.g. "12. §"), `page_number`. The
`query_log` logs the questions. The `documents.status` can be `active`,
`needs_ocr` (scanned, still without text), or `superseded` (a more authoritative source
has replaced it) — search only looks at `active`.

## Flow 1 — Ingestion (offline, `ingestion/run.ts`)

Ingestion runs independently of the request path and only touches the query side
through the DB.

1. **Startup (`run.ts`):** reads the env and the tenant config, builds the
   embedding client, and — depending on an env switch — an **OCR hook** and a
   **categorizer hook**. Selects the sources to process
   (`config.sources`, optionally with a `--source=` filter).
2. **Adapter instantiation (`registry.ts`):** from the source descriptor (`SourceDescriptor`)
   it creates the appropriate `DocumentSource` adapter.
3. **Generic pipeline (`pipeline.ts` → `ingestSource`)** — the same for every adapter:
   1. `source.list(ctx)` — the adapter lists the documents (`SourceDocument`),
      handling pagination/external APIs itself (e.g. `dlp-library` the admin-ajax).
   2. **Change detection:** `documents.findByExternalId` — if the document is already `active`
      and the `change_token` is unchanged, it skips it (no re-download).
   3. `source.fetch(doc)` — the adapter downloads the binary content (`FetchedContent`).
   4. **Text extraction (`extract.ts`):** PDF → pdfjs page by page; if there is
      effectively no text → `likelyScanned`.
   5. **OCR (`ocr.ts`), if scanned and an OCR hook is present:** pdfjs renders the page to an
      image (`@napi-rs/canvas`), then `tesseract.js` (Hungarian) extracts the text.
      Without OCR the document gets a `needs_ocr` mark (no chunk, not searchable,
      but trackable).
   6. **Categorization (`categorize.ts`), if not a "trustCategory" source:** it refines the category
      from the extracted text (whereas it respects the category of the curated DLP source).
   7. **Chunking (`chunk.ts`):** `§`-aware chunks with overlap.
   8. **Embedding (`embed-text.ts` + `llm`):** the embedded text = document title +
      chunk (so the title — e.g. a date — becomes searchable), batched.
   9. **Storage:** `documents.upsertDocument` + `chunks.replaceChunks` (both the vector and the
      `tsv` are stored).
   10. **Supersede:** if a source is "authoritativeFor" a category (e.g.
       `njt-decrees` for `rendeletek`), at the end of ingestion it sets the other sources'
       documents of the same category to `superseded` (`documents.supersedeOtherSources`).

Maintenance without re-downloading: `recategorize.ts` (recomputing categories from the stored
text) and `reembed.ts` (re-embedding chunks, if the embedding-text method changed).

## Flow 2 — Query (online, `/api/ask`)

1. **Request:** the frontend (`frontend/src/app/api.ts`) POSTs to `/api/ask`, and reads the
   SSE response with `fetch` + `ReadableStream`.
2. **Validation (`api/handlers.ts` → `createAskHandler`):** zod checks the question
   (max length from `TenantConfig.limits`); the IP rate limit runs in `middleware.ts`.
3. **Follow-up question rewrite (`retrieval/prompt.ts` → `rewriteFollowUp`):** if there is
   conversation history, a cheap LLM call produces a standalone search question from it.
4. **Embedding + keyphrase:** the `EmbeddingClient` converts the search question into a
   vector; in parallel a cheap LLM call (`prompt.ts` → `extractKeyphrase`) extracts the
   question's topic (e.g. "kommunális adó") for the authoritative title match.
5. **Candidate search (two sources → rerank window):**
   - **generic hybrid pool** (`retrieval/search.ts` → `hybridSearch`): pgvector (cosine)
     + Hungarian full-text (GIN) with RRF fusion, recency and **category weighting**,
     `ts_rank` length normalization;
   - **guaranteed authoritative shortlist** (`search.ts` → `authoritativeShortlist`): from
     `rag.authoritativeCategories` (`rendeletek`/`oldalak`) with **filtered-KNN** with raised
     `hnsw.ef_search` + **keyphrase→title match** (only on a real match).
   The handler **merges** the two (dedup) — this is the rerank window.
6. **Guardrail (`handlers.ts`):** if the window's best cosine similarity is below `minScore`
   (or empty) → a ready "I don't know" answer, and it ends.
7. **Rerank (`prompt.ts` → `rerankChunks`):** authority-aware LLM rerank filters the window
   by relevance down to **top-K**. The guarantee is about *bringing in* the authoritative source,
   the final ordering is decided by the rerank.
8. **Prompt assembly (`prompt.ts` → `buildAnswerMessages`):** system prompt
   (hallucination prohibition, citation rule) + the numbered `[Forrás N]` context block + the question.
9. **Streaming the answer (`llm` → `streamChat`):** the LLM's tokens are sent by `sse.ts`
   as `token` events.
10. **Citation + sources:** `prompt.ts` → `selectUsedChunks` filters to the actually used
    sources, `buildSources` deduplicates per document → `sources` event, then `done`.
11. **Logging:** the question/rewritten question/answer/found chunks into the `query_log` (best-effort).
12. **Rendering (frontend):** the tokens assemble into continuous text, with the
    sources and the legal disclaimer below them. (Any leftover `[Forrás N]` marker is cleaned up by the frontend.)

## The path of a question — "mennyi a kommunális adó?"

Let's follow concretely what happens when the user types into the chat
**"mennyi a kommunális adó?"** — from the browser to the source-attributed answer.

1. **The user types and sends (frontend).** The text goes into the `draft` signal
   (`frontend/src/app/app.html` textarea). Enter or the Send button calls the component's
   `send()` method (`frontend/src/app/app.ts`): this assembles the conversation so far
   as `history`, adds a user message and a "pending"
   assistant bubble, then calls `AssistantApi.ask("mennyi a kommunális
   adó?", history)`.
2. **The request starts (frontend → backend).** `AssistantApi.ask`
   (`frontend/src/app/api.ts`) sends a `POST /api/ask` with `{question, history}`
   JSON. During dev `proxy.conf.json` routes `/api` to the backend (`:3001`).
   It does NOT wait for the whole response: reading the `ReadableStream`, it converts the `data:` SSE frames
   into `AskEvent`s and passes them on as they arrive.
3. **The backend receives it (`/api/ask`).** The Express app (`backend/src/api/app.ts`)
   first lets the POST `/api/ask` through the IP-based `rateLimit` middleware (`middleware.ts`),
   then to the `createAskHandler` handler (`backend/src/api/handlers.ts`).
4. **Validation + opening the SSE.** The handler checks the question with zod (not empty, and
   below `TenantConfig.limits.maxQuestionChars`). If invalid → `400`. If valid,
   `initSse` (`sse.ts`) sets the SSE headers, and an `AbortController` watches
   whether the client disconnects prematurely.
5. **Follow-up rewrite — skipped here.** `rewriteFollowUp` (`retrieval/prompt.ts`)
   returns the question unchanged for empty `history`. (If, for example, they had previously asked
   about the communal tax and now wrote "és mikor kell fizetni?",
   here a cheap LLM call would make a standalone search question out of it.)
6. **Embedding + keyphrase.** The handler runs in parallel
   `EmbeddingClient.embed(["mennyi a kommunális adó?"])` (`llm/openai.ts`,
   `text-embedding-3-small` → 1536-dimensional vector) and `extractKeyphrase`
   (`prompt.ts`) — the latter extracts the topic: "kommunális adó".
7. **Candidate search (two sources → rerank window).** (a) `hybridSearch`
   (`retrieval/search.ts`): the **RRF** fusion of the **semantic** (`chunks.embedding` cosine, HNSW) and the
   **Hungarian full-text** (`chunks.tsv`, GIN, `ts_rank` length normalization) lists,
   with recency and **category weighting** → generic pool. (b) `authoritativeShortlist`
   (`search.ts`): from `rendeletek`/`oldalak` with **filtered-KNN** with raised `hnsw.ef_search`
   (against HNSW post-filter starvation) + **title match** on the "kommunális adó" keyphrase →
   this guarantees that the authoritative njt decree about the *communal tax* gets in. The handler
   merges the two (dedup) — this is the rerank window.
8. **Guardrail.** If the window's best cosine similarity is below `rag.minScore` (0.2)
   (or empty) → a ready "I can't find this in the documents…" answer, and it ends. Here there is a good
   hit, it continues.
9. **Rerank.** The authority-aware LLM rerank of `rerankChunks` (`prompt.ts`) filters the window
   by relevance down to **top-K** (8) chunks (bringing in the authoritative decree is guaranteed, the
   ordering is decided by the rerank).
10. **The prompt is assembled.** `buildAnswerMessages` (`prompt.ts`) builds the
   messages: the **system prompt** (from `TenantConfig.rag.systemPromptTemplate`, with
   `{displayName}` substituted in — it contains the "answer exclusively from the sources"
   and the citation rule), then a user message in which `buildContextBlock`
   joins the hits into numbered **`[Forrás N]`** blocks (title, `§`, page +
   chunk text), and finally the question itself.
11. **LLM call, streamed.** The handler calls `ChatClient.streamChat(messages, onToken)`
    (`backend/src/llm/openai.ts`, `gpt-4.1-mini`). As the tokens arrive, the
    `sse.ts` `sendEvent` sends them to the client as `{type:'token', text}` events —
    e.g. "A kommunális adó mértéke … 12.000 Ft évente …".
12. **Citation + sources + closing.** `selectUsedChunks` (`prompt.ts`) filters, based on the answer,
    to the actually used chunks, then `buildSources` creates a per-document
    deduplicated `Source[]` (title, category, `source_url`, page, `§`) → `{type:'sources'}`,
    then `{type:'done'}`.
13. **Logging.** `logQuery` (`handlers.ts`) writes the question, the rewritten question,
    the answer and the found chunk ids into the `query_log` in fire-and-forget mode.
14. **Rendering (frontend).** The `App.send()` loop consumes the events: it appends the
    `token`s to the `assistant.text` signal (a live typing feel), puts the `sources` below the
    bubble as clickable links, and finalizes on `done`. The user sees the
    continuous answer, with the **source** below it (the communal tax decree,
    with an `njt.jog.gov.hu/jogszabaly/…` link) and the legal disclaimer.

In short: `app.ts` → `api.ts` → `api/app.ts` → `handlers.ts` → (`prompt.rewriteFollowUp`)
→ `llm.embed` + `prompt.extractKeyphrase` → `search.hybridSearch` + `search.authoritativeShortlist`
→ (merged window) → `prompt.rerankChunks` → `prompt.buildAnswerMessages` → `llm.streamChat`
→ `prompt.selectUsedChunks` + `prompt.buildSources` → SSE → back into `app.ts`.

## Cross-cutting principles

- **Two seams:** everything municipality-specific is behind the `DocumentSource` adapters
  (`backend/src/ingestion/sources/`) and the `TenantConfig` (`config/tenants/`);
  the core (pipeline, retrieval, API) knows nothing about a concrete municipality.
- **Secrets:** the OpenAI key EXCLUSIVELY from env (`OPENAI_API_KEY`), never in the config.
- **Guardrails:** `minScore` threshold, mandatory source attribution, disclaimer, IP rate limit,
  CORS + CSP `frame-ancestors` (only the allowed embedding origins).
- **Authority/in-force status:** `njt-decrees` is the authoritative source of the decrees, and
  with `supersede` it replaces the less reliable (e.g. scanned) copies.
- **Single-tenant:** there is no `tenant_id` in the DB; one deployment = one municipality.
