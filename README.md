> **English** · [Magyar](README.hu.md)

# Municipal Assistant (`municipal-assistant`)

> **About this project.** A production-shaped, Hungarian-language RAG assistant built
> end-to-end as an **AI-augmented delivery**: it answers residents' questions **strictly
> from a municipality's official documents**, with source citation and an "I don't know"
> guardrail. The substance is in the source adapters (reverse-engineered WordPress Document
> Library Pro admin-ajax, the National Legislation Database, a public Google Drive),
> Hungarian OCR for scanned minutes, and a hybrid + reranked retrieval pipeline tuned with
> measured before/after evidence. The engineering judgment is documented as it happened —
> see **[docs/DECISIONS.md](docs/DECISIONS.md)** (ADR-lite, incl. trade-offs and known
> limitations), **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** (design + the journey of a
> question through the code), and **[docs/RETRIEVAL_NOTES.md](docs/RETRIEVAL_NOTES.md)**
> (before/after retrieval measurements). The specification is in
> [docs/BRIEF.md](docs/BRIEF.md); the commit history reflects a small-step, PR-reviewed,
> AI-paired workflow.

An embeddable chat web application that answers residents' questions **based on a
municipality's official documents**, with source attribution. Under the hood it runs RAG
(retrieval-augmented generation) with hybrid search (PostgreSQL + `pgvector`
semantic + Hungarian full-text).

The product is **tenant-agnostic**; everything municipality-specific sits behind two "seams":
the `DocumentSource` adapter (source discovery/download) and the `TenantConfig`
(branding, sources, RAG parameters). The **MVP tenant: Vácrátót**.

## Features

- **Hybrid search:** semantic (pgvector) + Hungarian full-text (GIN), with RRF fusion,
  with a slight **freshness weighting** (the more current document ranks higher).
- **Guardrails:** below the `minScore` threshold an "I don't know" answer, mandatory
  source attribution, legal disclaimer, IP-based rate limit, CORS + CSP `frame-ancestors`.
- **Source adapters** (seam #1): `manual-upload`, `dlp-library` (the vacratot.hu
  curated Document Library Pro listing) and `njt-decrees` (in-force decrees +
  attachments from the National Legislation Database). The old `wordpress-accordion` remains in the registry,
  but the Vácrátót config now uses `dlp-library`.
- **Scanned PDF → Hungarian OCR** (Tesseract/`tesseract.js`, local, no system dependency).
- **Content-based categorization** (from the document's text, not the file name).
- **Query logging** (`query_log`) for quality measurement.
- **SSE-streamed answer** + embeddable Angular UI with auto-height.

## Monorepo layout (npm workspaces)

```
municipal-assistant/
├─ shared/      # tenant-agnostic types (DTOs, DocumentSource, TenantConfig)
├─ config/      # config loader + tenants (seam #2)  — config/tenants/vacratot.ts
├─ backend/     # Express API, ingestion pipeline, DB, RAG, OCR
└─ frontend/    # Angular 21 chat UI (embeddable in an iframe)
```

## Prerequisites

- Node.js **>= 20.19**, npm **>= 10**
- Docker (for the local Postgres + pgvector)
- OpenAI API key

## Setup

```bash
# 1) Dependencies
npm install

# 2) Environment variables
cp .env.example .env       # then fill it in (at least OPENAI_API_KEY)

# 3) Database (Postgres + pgvector in docker)
npm run db:up

# 4) Migrate the schema
npm run migrate
```

### Secrets

The OpenAI key comes **exclusively** from `.env` (`OPENAI_API_KEY`) — it never goes into
code or the tenant config. `.env` is in `.gitignore`; only `.env.example` is
versioned.

## Running

```bash
# Load documents from the local data/uploads folder (manual-upload adapter)
npm run seed

# Or reindex all configured sources
npm run reindex

# Backend dev server (SSE /api/ask)
npm run dev
```

### Quick test

1. Put a few PDFs into the `data/uploads/` folder.
2. `npm run seed` — loads, chunks, embeds and upserts them.
3. `npm run dev`, then:

```bash
curl -N -X POST http://localhost:3001/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"Mennyi a kommunális adó?"}'
```

The response is an **SSE** stream: `token` events for the text, at the end a `sources`
event with the sources, then `done`.

## Sources (adapters, seam #1)

- **`manual-upload`** — reads PDF/TXT files from a local folder (`data/uploads/`).
  Per file, an optional `<filename>.meta.json` (`title`, `category`, `sourceUrl`,
  `publishedAt`) can override the metadata. It is the fastest way to test the
  full pipeline. Start: `npm run seed`.
- **`dlp-library`** — the `vacratot.hu/dokumentumok` **curated Document Library Pro**
  listing (the canonical source). Using a nonce freshly read from the page, it calls the
  `admin-ajax.php` `dlp_fetch_table` endpoint **per category** (per folder), and parses
  the entire table of the response (title, file URL, **real DLP category**),
  including the **external-link** items (e.g. njt/Drive). It replaces the old
  `wp/v2/media` solution: no media-library noise, real categories, and no
  heuristic is needed (`trustCategory`). Scanned PDFs get OCR here too.
  (The old `wordpress-accordion` adapter remains in the registry, but the Vácrátót
  config now uses `dlp-library`.)
- **`njt-decrees`** — the **authoritative source** of **in-force** municipal
  decrees from the National Legislation Database (`njt.jog.gov.hu`). It paginates the
  "in-force only" filtered list view (server-rendered HTML), and extracts the
  §-aware text of the decree page. It also downloads and extracts/OCRs the decree's
  **attachment PDFs** (fee tables, budget) (`includeAttachments`,
  `ocrAttachments`). It cites the source + links back to njt, it does not republish it.
  Because of `options.authoritativeFor: ['rendeletek']`, after a successful load it
  **supersedes** (`superseded`) the `rendeletek` documents of the other sources (e.g. the
  vacratot.hu scanned ones). **Note:** njt rate-limits; the adapter
  works with polite delays. (From some networks njt may block automated
  requests — the load runs from where njt is reachable.)

> **Cost/time:** the cost of embedding (`text-embedding-3-small`) is negligible
> (cents), the OCR is local (free). The main "price" of `reindex` is **time**: many PDFs
> with polite delays + OCR can take tens of minutes. For development,
> `seed` (manual-upload) is the fast path.

**Scanned PDFs (OCR):** where there is no extractable text layer (scanned image),
the pipeline runs **Tesseract (Hungarian) OCR** (`tesseract.js` + PDF→PNG
render with `@napi-rs/canvas` — no system-level dependency). The goal is
**searchability and citability**, not a perfect transcript: for signed/stamped/skewed
scans the text can be noisy. Switches: `OCR_ENABLED`, `OCR_MAX_PAGES`,
`OCR_VIEWPORT_SCALE` (see `.env.example`).

If the OCR also returns an empty result (or `OCR_ENABLED=false`), the document
is marked `status='needs_ocr'` with no chunk — it remains unsearchable, but
trackable and re-indexable at any time (the load always reprocesses non-`active`
documents). To list:
`SELECT external_id, title FROM documents WHERE status = 'needs_ocr';`

**Categorization:** the load determines the document's category from the **content**
(extracted/OCRed text), not from the file name — based on the `TenantConfig`
`categoryKeywords` (per category key, order = priority) keywords,
with a fallback derived from the category labels. To recategorize already-loaded documents
(without re-fetch/embed): `npm run recategorize`.

## Frontend (Angular 21 chat UI)

A minimal, embeddable chat interface (BRIEF point 7): welcome message, streamed
answer, clickable sources, legal disclaimer. It loads the branding from the backend's
`GET /api/config` endpoint (so seam #2 stays clean).

```bash
# 1) The backend must be running (in another terminal: npm run dev)
# 2) Angular dev server — proxies the /api calls to the backend (localhost:3001)
npm run dev:frontend
```

The dev server is available at `http://localhost:4200`. The `/api/*` requests are
routed to the backend by [frontend/proxy.conf.json](frontend/proxy.conf.json), so there is
no CORS trouble during development.

**Build:** `npm run build -w frontend` → static files in `frontend/dist/`.

### Embedding in an iframe (auto-height)

The app signals the content height to the parent page via `postMessage` (no
internal scrolling). On the embedding WordPress subpage:

```html
<iframe id="ugyseged" src="https://<host>/ugyseged" style="width:100%;border:0"></iframe>
<script>
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'municipal-assistant:resize') {
      document.getElementById('ugyseged').style.height = e.data.height + 'px';
    }
  });
</script>
```

> `TenantConfig.embed.allowedOrigins` (CORS + CSP `frame-ancestors`) controls
> which pages may embed it.

## Useful commands

| Command                             | What it does                            |
| ----------------------------------- | --------------------------------------- |
| `npm run db:up` / `npm run db:down` | Start/stop local Postgres               |
| `npm run migrate`                   | Create/update DB schema                 |
| `npm run seed`                      | Load with the `manual-upload` adapter   |
| `npm run reindex`                   | Load all configured sources             |
| `npm run recategorize`              | Recategorize existing documents         |
| `npm run dev`                       | Backend dev server                      |
| `npm run dev:frontend`              | Angular dev server (with proxy)         |
| `npm run build -w frontend`         | Frontend production build               |
| `npm run lint` / `npm run format`   | Lint / format (backend packages)        |
| `npm run typecheck`                 | Type checking (shared/config/backend)   |

## API

| Endpoint            | Description                                        |
| ------------------- | -------------------------------------------------- |
| `POST /api/ask`     | RAG answer as an SSE stream (token → sources → done) |
| `GET /api/health`   | Readiness check                                    |
| `GET /api/config`   | Tenant branding + limits for the UI                |
| `POST /api/reindex` | Protected (Bearer `REINDEX_TOKEN`) manual load     |
