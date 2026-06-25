> **English** · [Magyar](DECISIONS.hu.md)

# Decision Log (ADR-lite)

The project's more significant technical and architectural decisions, concisely. A lightweight
ADR format (Architecture Decision Record): for each decision, what we chose, what
problem it answers, why, instead of what, and what the status is.

The content is derived from the code, the dependencies, the config, and the commit history.
Where the rationale could not be read out with certainty, `> TODO` marks that it awaits
confirmation — we deliberately did not invent a rationale.

> **Convention:** we filled in the "Why" and "Alternative" fields only where it
> actually follows from the repo. Better incomplete and accurate than complete and invented.

---

## 1. PostgreSQL + pgvector as a single data store

- **Decision:** Documents, chunks, embeddings (`vector(1536)`), the full-text index, and
  the question log all live in a single PostgreSQL, with the `pgvector` extension
  (`pgvector/pgvector:pg16`, see [docker-compose.yml](../docker-compose.yml),
  [001_init.sql](../backend/src/db/migrations/001_init.sql)).
- **Context:** RAG needs vector similarity search, but also relational data (sources,
  status, logs) and Hungarian full-text. Point 6 of the BRIEF prescribed this.
- **Why:** One data store is enough — the relational, full-text, and vector needs can all
  be served from Postgres, so there is no separate system to keep in sync.
- **Alternative:** A dedicated vector database (e.g. Pinecone/Qdrant) alongside the relational DB —
  operating and syncing a second system, unnecessary for the MVP.
- **Status:** Valid.

---

## 2. Hybrid search (full-text + vector), with RRF fusion and freshness weighting

- **Decision:** Search combines, in a single SQL, the semantic (pgvector cosine,
  HNSW index) and the Hungarian full-text (`to_tsvector('hungarian', …)`, GIN index)
  results with **Reciprocal Rank Fusion**, then adds a slight **freshness weighting** on top
  (see [search.ts](../backend/src/retrieval/search.ts), commit `b4b09c8`).
- **Context:** Purely semantic search loses exact phrases/numbers
  (e.g. "kommunális adó", decision numbers), while purely full-text loses paraphrase.
- **Why:** The two searches cover each other's blind spots; RRF is rank-based, so there is no
  need to normalize scores of different scales. The freshness boost brings the more current
  document forward when several sources with differing dates match.
- **Alternative:** Weighted score summation (point 12 of the BRIEF also raised this) —
  scaling/normalization is questionable; RRF is simpler and more robust on ranks.
- **Status:** Valid.

---

## 3. `DocumentSource` adapter abstraction (seam #1)

- **Decision:** Every deeply site-specific part (discovery + download) is placed behind a common
  `DocumentSource` interface (`list()` + `fetch()`); the ingestion pipeline
  only knows the interface (see [shared](../shared/src/), `registry.ts`,
  `pipeline.ts`, and the adapters in `backend/src/ingestion/sources/`).
- **Context:** Every municipality publishes differently (WordPress DLP, njt.hu, manual upload);
  the core must stay independent of this.
- **Why:** Launching a new municipality = new config + (if needed) a new adapter, without touching
  the core. The pipeline (chunking, embedding, upsert, OCR) is thus source-agnostic.
- **Alternative:** Source-specific logic directly in the pipeline — does not scale
  to multiple municipalities, violates the tenant-agnostic core.
- **Status:** Valid. (Live adapters: `manual-upload`, `dlp-library`, `njt-decrees`,
  and `wordpress-accordion`, which remained in the registry.)

---

## 4. Single-tenant, config-driven setup (seam #2)

- **Decision:** A separate deploy per tenant; the schema does **not** contain a `tenant_id`
  ([001_init.sql](../backend/src/db/migrations/001_init.sql): "Single-tenant deployment").
  Every municipality-specific setting is in a `TenantConfig`, selected from the env
  (`loadTenantConfig(env.TENANT_ID)`); the MVP tenant:
  [vacratot.ts](../config/src/tenants/vacratot.ts).
- **Context:** We need to first get one municipal assistant working, with clean data and
  configuration isolation, without taking on multi-tenant complexity up front.
- **Why:** A single-tenant deploy is simple and gives natural isolation (a separate DB/instance
  per municipality); the config seam locks the branding/sources/RAG parameters into one place,
  keeping the core clean.
- **Alternative:** Multi-tenant, shared DB with a `tenant_id` column — every query would have to be
  filtered, and the risk of error (data leakage between tenants) is greater; deferred for the MVP.
- **Status:** Valid (multi-tenant mode deferred).

---

## 5. Curated DLP feed instead of `wp/v2/media`

- **Decision:** The vacratot.hu documents come from the **Document Library Pro** curated
  list (admin-ajax `dlp_fetch_table`, per folder = per category), not from the
  `wp/v2/media` REST library (see
  [dlp-library.ts](../backend/src/ingestion/sources/dlp-library.ts), config `trustCategory`,
  commit `0adfd58`).
- **Context:** The media library gives a raw file list without category or curation; the
  `/dokumentumok/` page, by contrast, shows a list organized into folders (Rendeletek, Jegyzőkönyvek, …),
  maintained by humans, with external links (njt, Drive) too.
- **Why:** The DLP folder **is the category itself** (no need for content heuristics,
  `trustCategory: true`), the list is curated (no media-library noise), and it also includes
  the external-link items.
- **Alternative:** `wp/v2/media` REST — media-library noise, missing real categories, the
  external links are left out. (The old `wordpress-accordion` adapter remained in the registry, but
  the Vácrátót config already uses `dlp-library`.)
- **Status:** Valid (supersedes the earlier `wp/v2/media` approach).

---

## 6. Handling scanned PDFs: `needs_ocr` status + local `tesseract.js`

- **Decision:** If there is no extractable text layer, the document is not dropped: it gets a `needs_ocr`
  status (commit `77e3395`), and if OCR is enabled, the Hungarian **`tesseract.js`**
  runs it (PDF→image render with `@napi-rs/canvas`), with an env switch
  (`OCR_ENABLED`, `OCR_MAX_PAGES`, `OCR_VIEWPORT_SCALE`) — see
  [ocr.ts](../backend/src/ingestion/ocr.ts), [run.ts](../backend/src/ingestion/run.ts),
  commit `6432235`.
- **Context:** Most of the minutes/decisions are scanned images; these must not be loaded
  as empty/junk text, but they must be trackable and reprocessable.
- **Why:** The `needs_ocr` mark makes the scanned ones visible and re-indexable
  (the ingestion always reprocesses non-`active` documents). `tesseract.js` is
  local and free, and thanks to `@napi-rs/canvas` there is **no system-level dependency**
  (portable). The goal is searchability/citability, not a perfect transcript.
- **Alternative:** (a) Silently drop the scanned ones — lost content, with no trace.
  (b) Cloud OCR — cost and data-privacy question. (c) Native Tesseract — a system-level
  dependency on the deploy. We chose the portable `tesseract.js`.
- **Status:** Valid.

---

## 7. njt.jog.gov.hu as the authoritative source for decrees (timing + supersede)

- **Decision:** The authoritative source for the **in-force** municipal decrees is the National
  Legislation Database (`njt-decrees` adapter); after a successful ingestion, via `authoritativeFor:
  ['rendeletek']` it **supersedes** (`superseded`) the decrees from other sources (e.g. the vacratot.hu
  scanned ones) (see [run.ts](../backend/src/ingestion/run.ts) supersede logic,
  config, commit `b55ec06`). The integration was built in a later round, after the full pipeline
  (manual-upload + WordPress) was up and running.
- **Context:** The vacratot.hu decrees are largely scanned (noisy OCR); njt
  gives in-force, machine-readable, §-structured text.
- **Why:** njt is the official, in-force text → this should be the authoritative source, and it should
  supersede the lower-quality copies. The `requestDelayMs: 3000` + exponential
  backoff (commits `7a6126f`, `23c1214`) is needed because njt aggressively rate-limits
  (HTTP 500 under a burst); the failed documents are not upserted, so the
  rerun converges.
- **Alternative:** Ingesting the decrees from the vacratot.hu scanned PDFs — mixed
  OCR quality, not necessarily in-force. For this reason the `Rendeletek` folder from the DLP source
  is explicitly excluded (`excludeCategories`), in favor of njt.
- **Status:** Valid. (Previously deferred to a later round; now implemented and the
  authoritative source.)
- **Note:** From some networks njt may block automated requests — the
  ingestion runs from where njt is reachable.

---

## 8. Cheap LLM + embedding model, behind a swappable interface

- **Decision:** `chatModel = gpt-4.1-mini`, `embeddingModel = text-embedding-3-small`
  (1536 dim), behind a swappable LLM interface (see
  [vacratot.ts](../config/src/tenants/vacratot.ts) `rag`, [openai.ts](../backend/src/llm/openai.ts)).
- **Context:** RAG requires many embeddings and answer streams; both the Hungarian language
  quality and the cost matter. Point 2 of the BRIEF and an in-flight decision recorded this.
- **Why:** Per the rationale in the config, cheap models that also perform well in Hungarian;
  the cost of the embedding (`text-embedding-3-small`) is negligible. The
  interface is swappable, so the provider/model can be adjusted later.
- **Alternative:** Larger models (e.g. `gpt-4.1`, `text-embedding-3-large`) — higher
  cost; or local models — uncertain Hungarian quality. Because of the interface, this
  choice is reversible.
- **Status:** Valid.

---

## 9. Contextual chunks (the title in the embedded text)

- **Decision:** The document title is prepended to the embedded text
  (`buildEmbedText(title, content)`), and top-K grew to 8, with a date hint in the prompt
  (see [embed-text.ts](../backend/src/ingestion/embed-text.ts), commit `310edbe`).
- **Context:** A date-filtering question (e.g. "what happened on 28 July 2025") missed the
  minutes, because the date was only in the title, not in the chunk's text — and the many njt decrees
  crowded it out of the top-K.
- **Why:** If the title (and the date/type within it) is also in the embedded text,
  the chunk can also be found by the title.
- **Alternative:** Embedding only the raw chunk text — the signal in the title (date, type)
  is lost.
- **Status:** Valid.

---

## 10. Deploy: Hetzner + Docker Compose + Caddy + GitHub Actions

- **Decision:** A single small server (Hetzner CX22, Ubuntu) runs the stack with **Docker
  Compose**: **Caddy** (auto-HTTPS reverse proxy) + **backend** (Node; also serves the built
  Angular UI on the same origin) + **db** (pgvector). CI/CD: a push to `main` builds the
  backend image (frontend baked in) via **GitHub Actions**, pushes it to **GHCR**, then SSHes
  in to `pull` + `up -d` (see [docker-compose.prod.yml](../docker-compose.prod.yml),
  [Caddyfile](../Caddyfile), [backend/Dockerfile](../backend/Dockerfile),
  [deploy.yml](../.github/workflows/deploy.yml), [DEPLOY.md](DEPLOY.md)).
- **Context:** The backend is a Node server (Express, SSE), the frontend a static Angular
  build; the goal was one small, low-cost VPS with simple ops. (Point 12 of the BRIEF listed
  hosting as an open question; now implemented.)
- **Why:** (a) One box, one `docker compose` — minimal moving parts. (b) Caddy gives automatic
  TLS, no manual certs. (c) The backend serving the built frontend = a single container/origin
  (no separate static host, no UI↔API CORS). (d) **tsx runtime:** the image runs the TS backend
  (+ the TS-source workspace packages) directly, so the only build step is the Angular bundle.
  (e) Secrets live ONLY in the server-side `.env` (never committed); the DB persists in the
  `db_data` volume and the deploy is `pull` + `up -d` only — **never `down -v`** (which would
  wipe the indexed corpus).
- **Alternative:** (a) PaaS (Render/Fly/Railway) — simpler, but more cost/lock-in and less
  control on a hobby budget. (b) Kubernetes — vastly over-engineered for one tenant.
  (c) A separate static host for the frontend — an extra origin + CORS for no benefit here.
- **Status:** Implemented (was deferred).

---

## 11. Extracting the njt decree body from `<div>` too, not only from `<p>`

- **Decision:** `parseDecreeText` extracts the full text of the `#jogszab` element with block-level
  wrapping (in a single pass), not only the `h1/h2/p` elements.
- **Context:** njt's **newer** decrees put the body in `<p>`, the **old ones** (e.g. the
  2004/2011 tax decrees) in `<div>`. The old parse read only `h1/h2/p`, so out of 139
  decrees **56 were ingested with only a title** (~109 characters), losing the actual
  tax rates.
- **Why:** The `<div>` body can be extracted in a single pass (full text of `#jogszab`, with block wrapping)
  without duplication, and it does not break the `<p>`-based ones either.
- **Alternative:** Adding only `<div>` to the selector — because of the nested `<div>`s it would
  duplicate the text.
- **Status:** Valid. Verified: kommunális adó "12.000,-Ft/adótárgy/év", építményadó
  "220,-Ft/m2", telekadó "20 Ft/m2"; the `<p>`-based large decrees are unchanged.

---

## 12. Retrieval quality in layers — one symptom, two (three) separate problems

- **Decision:** We improve retrieval quality **layer by layer**, and handle the different causes
  separately; we do not immediately pull a "big solution" onto a symptom.
- **Context:** The "how much is the kommunális/építményadó?" questions gave wrong/empty answers. The
  investigation uncovered three layers of **different nature**:
  1. **Data gap:** the body of the authoritative decrees was missing (see point 11) — a *data problem*
     that could not have been solved by retrieval tuning.
  2. **Pool truncation:** even after fixing the data, the authoritative source sinks, because the
     high-frequency topic words ("adó", "bérleti") let the archive mass crowd it out
     before the rerank window.
  3. **HNSW post-filter:** the category-filtered ("only rendeletek/oldalak") semantic search
     starves — HNSW gives the top-`ef_search` globally nearest, and filters
     to category AFTERWARDS, so barely any authoritative candidate remains.
- **Why:** Proceeding layer by layer revealed that a good part of the symptom was a **data error**; an
  early "big retrieval solution" would have masked this, and we would have tuned on bad data.
- **Alternative:** A complex reranker straight onto the symptom — blindly, on faulty data.
- **Status:** Partly valid. Point 11 (data) is **fixed**; layers 2–3 (pool truncation,
  filtered-KNN) are solved in point 13 (retrieval redesign).

---

## 13. Retrieval redesign: authoritative shortlist (filtered-KNN + title match) + LLM rerank

- **Decision:** The query builds the rerank window from two sources: (a) the general hybrid
  pool (`hybridSearch`, with `categoryWeights` + `ts_rank` length normalization), and (b) a
  **guaranteed authoritative shortlist** (`authoritativeShortlist`) from the `rendeletek`/`oldalak`
  categories. The unified window of the two is filtered to top-K by an **authority-aware LLM rerank**
  (`rerankChunks`). The shortlist has two branches: **filtered-KNN** with a raised
  `hnsw.ef_search`, and a **keyphrase→title match** (`extractKeyphrase` → against the authoritative
  document's title, only on a genuine websearch match).
- **Context:** Layers 2–3 of point 12: the authoritative source fell out before the rerank window, and the
  category-filtered KNN starved because of the HNSW post-filter.
- **Why:** The **guarantee is about ENTRY, not winning** — the final ordering is decided by the
  meaning-based rerank, we do not force the decrees up. Raising `hnsw.ef_search`
  is needed because HNSW gives the globally nearest, and the category filter runs
  afterwards (by default ~0 authoritative candidates remain). **A separate root bug:** the config zod schema previously
  **stripped out** the `authoritativeCategories`/`categoryWeights` fields (they were not in the
  schema) — which is why they appeared ineffective; once added to the schema they work.
- **Alternative:** (a) Forcing the decree up — violates the "entry, not winning"
  principle, would give the wrong source for off-topic questions. (b) Cross-encoder reranker — a heavy
  dependency + memory/speed on the small VPS; only if these two are not enough (it was not
  needed). We dropped the injection in `hybridSearch` (the shortlist replaces it) — there are no two
  overlapping solutions.
- **Status:** Valid. Before/after, on all 6 questions, on real data: in the baseline 4/6 did not even
  make it into the top-20; after the redesign all 6 authoritative sources are in the top-8 context,
  the answers are correct (kommunális 12.000 Ft, építmény 220 Ft/m², telek), the controls did not
  regress (ebtartás #1, tűzifa #3→#1, nagyterem —→#1). This replaces the `feat/retrieval-rerank` PR
  (to be closed).

---

## 14. Floating widget embed instead of an inline iframe

- **Decision:** The host site embeds the chat as a **floating launcher widget**
  (Intercom/Crisp style), loaded with a single `<script src=".../widget.js" defer>`, rather
  than a hand-placed inline iframe. The backend serves a self-contained, dependency-free
  loader at `GET /widget.js` ([widget.ts](../backend/src/api/widget.ts) + `createWidgetHandler`);
  the app detects `?embed=widget` and switches to a compact, fill-height panel layout.
- **Context:** The host (`vacratotikozosseg.hu`, WordPress) needs a **site-wide** embed that
  doesn't slow page load and doesn't require placing/sizing an iframe by hand on each page.
- **Why:** (a) **Lazy:** the iframe is created only on first open, so the host page's initial
  load is untouched. (b) **One line, site-wide:** a single script tag in a header/footer
  plugin — no per-page markup. (c) **Self-contained:** vanilla JS, no framework on the host,
  namespaced (`maw-`) styles and a very high `z-index` — minimal collision with the host theme.
  (d) **Origin-derived:** the iframe origin comes from the script's own request, so the same
  build works on any deployment; title/accent come from `TenantConfig`. (e) **Accessible:**
  `aria-label`s, Esc-to-close, focus return, responsive (desktop panel, fullscreen on mobile),
  and a discrete one-time greeting bubble that never auto-opens aggressively.
- **Alternative:** (a) Inline iframe with `postMessage` auto-height (the earlier embed) —
  needs per-page placement and grows the page; replaced. (b) A web-component / framework widget
  — a heavier dependency on the host. (c) Shadow DOM isolation — stronger style isolation, but
  an injected `<style>` + a namespace is enough for WordPress and simpler.
- **Status:** Valid. Embedding stays gated by `TenantConfig.embed.allowedOrigins` (apex + www),
  which drives both CORS and the CSP `frame-ancestors`; it assumes the host page has no CSP that
  blocks a cross-origin script / inline style (rare on WordPress).
