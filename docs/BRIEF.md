> **English** · [Magyar](BRIEF.hu.md)

# Municipal Assistant — `municipal-assistant` (Claude Code brief, round 1)

> The product name is **generic**: `municipal-assistant` (in Hungarian "Önkormányzati Ügysegéd").
> **Vácrátót is the first tenant (MVP tenant)**, not the product itself. Everything
> Vácrátót-specific goes behind the two seams (section 4).

> Give this file to the Claude Code session as a starting point. The prose explanation
> is in Hungarian, the code and the identifiers are in English (the repo's language). The concrete
> deliverables of round 1 are listed in section 10.

---

## 1. What we are building (goal)

An embeddable chat web application that answers residents' free-text questions based on
a municipality's official documents, **with source attribution**
(e.g. "how much is the communal tax?" → answer + the link/page of the relevant decree).

The interface is a clean, friendly chat. In the background, RAG (retrieval-augmented
generation) runs with a cheap LLM. The documents are refreshed from time to time, kept
up to date by a scheduled ingestion pipeline.

**MVP: Vácrátót.** Source: https://vacratot.hu/dokumentumok/ (PDFs organized into
categories: Rendeletek, Jegyzőkönyvek, Polgármesteri/HVB határozatok, Nyomtatványok,
Szerződések, Településrendezési tervek, Hírmondó; plus a Google Drive "Üvegzseb"
folder and njt.hu's decrees in force). Among the Rendeletek there is e.g. the communal tax.

**Important constraint: portability.** Other municipalities can also adopt it with mild
developer customization. That is why everything municipality-specific goes behind two
well-delimited "seams" (section 4), and the rest of the code knows nothing about Vácrátót.

The embedding target is a subpage of the `https://vacratotikozosseg.hu/` WordPress site
(e.g. `/ugyseged`), as an iframe.

---

## 2. Tech stack (fixed decisions)

- **Frontend:** Angular 21 (TypeScript). Embeddable in an iframe.
- **Backend:** Node + Express, **TypeScript**.
- **Database:** PostgreSQL + `pgvector`. **Hybrid search** (semantic vector +
  Hungarian full-text), in a single DB.
- **Streaming:** SSE for the chat answer.
- **Monorepo:** npm workspaces (`frontend` / `backend` / `shared`). NOT Nx, not Turbo —
  unnecessary for a project of this size.
- **Embedding:** a multilingual model (because of Hungarian), e.g. OpenAI `text-embedding-3-small`
  (1536 dim). Behind an interchangeable interface.
- **LLM:** a cheap model that is good at Hungarian (e.g. Gemini Flash or GPT-4o/4.1-mini class).
  Behind an interchangeable provider.
- **Secrets:** API keys exclusively from environment variables (`.env`), NEVER in the
  tenant-config file.

The ingestion pipeline runs independently of the request path (separate entry point / cron worker),
they only interact through the DB.

---

## 3. Architecture in a nutshell (two processes)

**Ingestion (offline, scheduled):**
source adapter (discovery + download) → PDF text extraction (OCR for scanned PDFs,
Hungarian language pack) → chunking (following the `§` structure of decrees where possible) →
embedding → upsert into the vector DB. It processes only the new/changed documents
(based on a change-detection token).

**Query (online):**
user's question → (for follow-up questions: a cheap LLM call that produces a standalone
search query from the conversation) → hybrid search top-k → the hits go into the LLM as context
with a strict system prompt → SSE-streamed answer + the list of sources at the end.

---

## 4. The two seams (this is what makes it portable)

Everything that is municipality-specific goes into THESE two; everything else is the general core.

1. **`DocumentSource` adapter** — the only deeply site-specific part. Responsible for
   discovering and downloading documents. From the download downward every step works
   with a uniform format, and does not know where the data came from. (Interface: section 11.)

2. **`TenantConfig`** — branding, embedding origin (CORS), category taxonomy,
   source descriptors, RAG parameters, system-prompt template, limits. (Type: section 11.)

Launching a new municipality: a new config file + (if needed) a new adapter + deploy.

---

## 5. Repo structure (monorepo)

```
municipal-assistant/
├─ package.json                # npm workspaces gyökér
├─ shared/                     # bérlő-agnosztikus típusok (DTO-k, DocumentSource, TenantConfig)
│  └─ src/
├─ backend/
│  └─ src/
│     ├─ api/                  # Express route-ok: /api/ask (SSE), /api/health, /api/reindex
│     ├─ retrieval/            # hibrid keresés + prompt-összeállítás
│     ├─ llm/                  # csereszabatos LLM- és embedding-kliens
│     ├─ ingestion/
│     │  ├─ pipeline.ts        # általános: download → parse/OCR → chunk → embed → upsert
│     │  ├─ registry.ts        # adapter-név -> factory(options) -> DocumentSource
│     │  └─ sources/           # ADAPTEREK (varrat #1)
│     │     ├─ wordpress-accordion.ts
│     │     ├─ google-drive.ts
│     │     └─ manual-upload.ts
│     ├─ db/                   # kapcsolat, migrációk, repository-k
│     └─ config/               # config-betöltő + séma-validáció (zod)
├─ config/
│  ├─ default.ts               # józan alapértelmezések (HU önkormányzati)
│  └─ tenants/
│     └─ vacratot.ts           # a Vácrátót TenantConfig (varrat #2)
└─ frontend/                   # Angular 21 chat UI (iframe-be ágyazható)
```

---

## 6. Data model (PostgreSQL + pgvector)

> The embedding dimension depends on the chosen model (text-embedding-3-small = 1536).
> For now it is **single-tenant** (separate DB/deployment per municipality), so there is NO `tenant_id`.
> If it later becomes multi-tenant, a `tenant_id` column + mandatory filtering go here.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
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

CREATE TABLE chunks (
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

CREATE INDEX chunks_tsv_idx ON chunks USING GIN (tsv);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

-- Opcionális, minőségméréshez és későbbi finomításhoz:
CREATE TABLE query_log (
  id                 BIGSERIAL PRIMARY KEY,
  question           TEXT NOT NULL,
  rewritten_query    TEXT,
  answer             TEXT,
  retrieved_chunk_ids BIGINT[],
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  feedback           SMALLINT      -- pl. -1 / +1, ha a UI ad visszajelzést
);
```

The hybrid search merges the results of `tsv` (GIN) and `embedding` (HNSW)
(e.g. RRF — reciprocal rank fusion, or a weighted score).

---

## 7. API

- `POST /api/ask` — input: `{ question: string, history?: ChatTurn[] }`.
  Output: **SSE** stream (answer tokens), at the end an event with the `Source[]` list.
- `GET  /api/health` — readiness/liveness check.
- `POST /api/reindex` — (admin, protected) manual triggering of ingestion.

The DTOs live in `shared`, so the frontend and the backend use the same ones.

---

## 8. Mandatory safeguards (guardrails)

- **Against hallucination:** the system prompt categorically forbids answering outside the
  context ("if it is not in the sources, say you don't know, and direct them to the office").
  At retrieval a `minScore` threshold: if there is no good enough hit → "I don't know" answer.
- **Source fidelity:** the LLM may only cite the received, identified chunks;
  the UI builds clickable sources from these (document + page).
- **Currency:** store `published_at`, prefer the more recent one; the
  `status` can mark an obsolete document. For decrees in force, njt.hu is a
  separate, reliable source.
- **Legal disclaimer:** at every answer/in the UI a short disclaimer ("information,
  not official legal advice; please verify in the source").
- **Public endpoint protection:** IP-based rate limit + max message length (TenantConfig.limits).
- **Embedding:** CORS and `frame-ancestors` (CSP) should only allow the `TenantConfig.embed.allowedOrigins`
  origins. Iframe auto-height via `postMessage` (no internal scrolling).

---

## 9. What we should NOT build NOW

- NO multi-tenant DB / `tenant_id` / tenant filtering. Single-tenant, config-driven.
- NO admin UI for tenant management.
- NO plugin system for the adapters beyond the `registry` mapping name→factory.
- Build Vácrátót **concretely**, disciplined, behind the two seams. Pick up further
  generalization when the second municipality actually arrives.

---

## 10. The concrete scope of round 1 (what this session should deliver)

The goal is a **thin, end-to-end working** vertical slice for Vácrátót.
If it is a lot, break it into steps; the order below is recommended.

1. **Monorepo scaffold:** npm workspaces, TypeScript, lint/format, `.env.example`,
   `docker-compose.yml` with a local Postgres + pgvector service.
2. **`shared` package:** the types of section 11 (DTOs, `DocumentSource`, `TenantConfig`,
   `Source`, `ChatTurn`).
3. **DB:** the schema of section 6 as a migration; simple repositories (documents, chunks).
4. **Config:** `config/default.ts` + `config/tenants/vacratot.ts`, with zod validation.
5. **Ingestion:**
   - `registry` (adapter name → factory),
   - `manual-upload` adapter (reads from a local folder — instantly testable with this),
   - `wordpress-accordion` adapter (best-effort for the vacratot.hu/dokumentumok structure;
     where the JS menu makes it hard, a well-documented TODO there),
   - general pipeline: download → PDF text extraction + OCR fallback (Hungarian) →
     chunking (`§`-aware, with overlap) → embedding → upsert (skip based on change token).
6. **Backend API:** `/api/health`, then `/api/ask` (SSE) with the full RAG path:
   (follow-up-question rewrite) → hybrid search → prompt → LLM → answer + sources +
   the guardrails of section 8.
7. **Frontend:** a minimal Angular chat shell (sending a question, displaying the streamed
   answer, list of sources), embeddable in an iframe, with auto-height.

**Minimum first commit (if it must be narrowed down a lot):** 1–5 + `/api/ask` happy path.
The frontend and the refinements can come in round 2.

Provide a short README for running it (local Postgres, env keys, `seed`/`reindex`,
dev server).

---

## 11. Code — `shared` types, `DocumentSource`, `TenantConfig`

> These go into `shared/src/`. The comments are in Hungarian so that the intent is unambiguous.

```ts
// ───────────────────────── shared/src/dto.ts ─────────────────────────

/** Egy beszélgetési forduló (követő kérdések kontextusához). */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Forrásmegjelölés egy válaszhoz — ebből épít a UI kattintható hivatkozást. */
export interface Source {
  documentTitle: string;
  category: string;
  sourceUrl: string;
  pageNumber?: number;
  sectionRef?: string; // pl. "12. §"
}

export interface AskRequest {
  question: string;
  history?: ChatTurn[];
}

/** SSE-eseménytípusok a /api/ask streamben. */
export type AskEvent =
  | { type: 'token'; text: string }              // részleges válaszszöveg
  | { type: 'sources'; sources: Source[] }       // a válasz forrásai (a végén)
  | { type: 'done' }
  | { type: 'error'; message: string };
```

```ts
// ──────────────────── shared/src/document-source.ts ──────────────────

/** Egy nyers forrásdokumentum leírója, még feldolgozás előtt. */
export interface SourceDocument {
  /**
   * Stabil, a forráson belül egyedi kulcs (pl. fájl-URL vagy Drive fileId).
   * Erre köt a deduplikáció és a változásfigyelés (documents.external_id).
   */
  externalId: string;

  title: string;

  /** A TenantConfig.categories egyik kulcsa (pl. "rendeletek"). */
  category: string;

  /** Ahonnan a felhasználó elérheti az eredetit (forrásmegjelöléshez). */
  sourceUrl: string;

  /** pl. "application/pdf" */
  mimeType: string;

  /**
   * Változásfigyelő token: amivel olcsón eldönthető, kell-e újra feldolgozni.
   * Bármi lehet (ETag, Last-Modified, méret, tartalom-hash). Ha null, mindig
   * újrafeldolgozandó (pl. ha a forrás nem ad megbízható jelet).
   */
  changeToken: string | null;

  /** Ha kinyerhető a forrásból. */
  publishedAt?: Date | null;

  /** Alapértelmezés a tenant locale-ja. */
  language?: string;

  /** Adapter-specifikus extra (a magnak nem kell értenie). */
  metadata?: Record<string, unknown>;
}

/** Egy dokumentum letöltött bináris tartalma. */
export interface FetchedContent {
  externalId: string;
  bytes: Uint8Array;
  mimeType: string;
}

/** Minimális, injektált logger (a konkrét implementációt a backend adja). */
export interface SourceLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** Futásidejű kontextus az adapternek. */
export interface DocumentSourceContext {
  tenantId: string;
  logger: SourceLogger;
  /** Megszakításhoz (időtúllépés, leállítás). */
  signal?: AbortSignal;
}

/**
 * VARRAT #1 — az egyetlen mélyen településspecifikus rész a betöltésben.
 *
 * Egy adapter két dologért felel:
 *  - list(): felfedezés (listázás + metaadat + változás-token),
 *  - fetch(): egy konkrét dokumentum bináris letöltése.
 *
 * A pipeline minden további lépése (PDF/OCR, darabolás, embedding, upsert)
 * ÁLTALÁNOS, és nem tudja, honnan jött az adat.
 */
export interface DocumentSource {
  /** Emberi név, logoláshoz/diagnosztikához (pl. "wordpress-accordion"). */
  readonly name: string;

  /**
   * Felsorolja az elérhető dokumentumokat.
   * AsyncIterable, hogy lapozható/streamelhető legyen, és ne kelljen mindent
   * egyszerre memóriában tartani.
   */
  list(ctx: DocumentSourceContext): AsyncIterable<SourceDocument>;

  /**
   * Letölti egy konkrét dokumentum tartalmát.
   * Külön lépés, mert egyes források (pl. Google Drive, hitelesített API-k)
   * saját letöltőt igényelnek — nem elég egy sima HTTP GET a sourceUrl-re.
   */
  fetch(doc: SourceDocument, ctx: DocumentSourceContext): Promise<FetchedContent>;
}

/**
 * Adapter-gyár: a registry a TenantConfig.sources[].adapter névhez ezt rendeli,
 * és az options-szal példányosítja. Az options típusát az egyes adapterek
 * szűkítik/validálják (pl. zod-dal).
 */
export type DocumentSourceFactory = (
  options: Record<string, unknown>,
) => DocumentSource;
```

```ts
// ─────────────────────── shared/src/tenant-config.ts ──────────────────────

/** Egy forrás-leíró a configban: melyik adapter, milyen paraméterrel. */
export interface SourceDescriptor {
  /** A registry-ben regisztrált adapter neve (pl. "wordpress-accordion"). */
  adapter: string;
  /** Adapter-specifikus paraméterek (pl. { baseUrl, categoryMap }). */
  options: Record<string, unknown>;
}

/**
 * VARRAT #2 — minden településspecifikus beállítás egy helyen.
 * Titkok (API-kulcsok) NEM ide jönnek, hanem env-ből.
 */
export interface TenantConfig {
  /** Gépi azonosító, pl. "vacratot". */
  tenantId: string;
  /** Megjelenítendő név, pl. "Vácrátót Község Önkormányzata". */
  displayName: string;
  /** BCP-47 locale, pl. "hu-HU". */
  locale: string;

  branding: {
    logoUrl?: string;
    primaryColor?: string;
    /** Üdvözlő üzenet a chat tetején. */
    welcomeMessage: string;
    /** Jogi figyelmeztetés (mindig látszik / minden válasznál). */
    disclaimer: string;
  };

  embed: {
    /** CORS + CSP frame-ancestors, pl. ["https://vacratotikozosseg.hu"]. */
    allowedOrigins: string[];
  };

  /** Taxonómia: kulcs → emberi címke. A SourceDocument.category ezekre hivatkozik. */
  categories: Record<string, string>;

  /** Milyen forrásokból töltünk. */
  sources: SourceDescriptor[];

  rag: {
    topK: number;
    /** Küszöb: ez alatt "nem tudom" válasz (hallucináció ellen). */
    minScore: number;
    embeddingModel: string;
    chatModel: string;
    /**
     * Rendszerprompt-sablon. Behelyettesítendő tokenek pl. {displayName}.
     * Tartalmazza a kontextuson-kívüli-válasz tiltását és az idézési szabályt.
     */
    systemPromptTemplate: string;
  };

  limits: {
    maxQuestionChars: number;
    requestsPerMinutePerIp: number;
  };
}
```

```ts
// ───────────────── config/tenants/vacratot.ts (minta) ─────────────────
import type { TenantConfig } from '../../shared/src/tenant-config';

export const vacratot: TenantConfig = {
  tenantId: 'vacratot',
  displayName: 'Vácrátót Község Önkormányzata',
  locale: 'hu-HU',

  branding: {
    welcomeMessage:
      'Üdvözlöm! Vácrátót hivatalos dokumentumai alapján dolgozom. Miben lehetek a segítségére?',
    disclaimer:
      'Ez tájékoztatás, nem hivatalos jogi tanács. Kérjük, ellenőrizze a megjelölt forrásban.',
  },

  embed: {
    allowedOrigins: ['https://vacratotikozosseg.hu'],
  },

  categories: {
    rendeletek: 'Rendeletek',
    jegyzokonyvek: 'Jegyzőkönyvek',
    polgarmesteri_hatarozatok: 'Polgármesteri határozatok',
    hvb_hatarozatok: 'HVB határozatok',
    nyomtatvanyok: 'Nyomtatványok',
    szerzodesek: 'Szerződések',
    telepulesrendezes: 'Településrendezési és szabályozási tervek',
    hirmondo: 'Vácrátóti Hírmondó',
  },

  sources: [
    {
      adapter: 'wordpress-accordion',
      options: {
        baseUrl: 'https://vacratot.hu/dokumentumok/',
        // a menü kategória-címkéit a fenti kulcsokra képezi:
        categoryMap: {
          'Rendeletek': 'rendeletek',
          'Jegyzőkönyvek': 'jegyzokonyvek',
          'Polgármesteri határozatok': 'polgarmesteri_hatarozatok',
          'HVB határozatok': 'hvb_hatarozatok',
          'Nyomtatványok': 'nyomtatvanyok',
          'Szerződések': 'szerzodesek',
          'Településrendezési és szabályozási tervek': 'telepulesrendezes',
          'Vácrátóti Hírmondó': 'hirmondo',
        },
      },
    },
    // Később: { adapter: 'google-drive', options: { folderId: '...' } }  // Üvegzseb
    // Lokális teszthez: { adapter: 'manual-upload', options: { dir: './data/uploads' } }
  ],

  rag: {
    topK: 6,
    minScore: 0.2,
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini', // vagy a választott olcsó modell
    systemPromptTemplate: [
      'Te {displayName} hivatalos ügysegéd asszisztense vagy.',
      'KIZÁRÓLAG a megadott forrásrészletek alapján válaszolj, magyarul, közérthetően.',
      'Ha a válasz nincs a forrásokban, mondd ki, hogy ezt nem találod a dokumentumokban,',
      'és javasold a hivatal megkeresését. Ne találj ki adatokat, számokat, határidőket.',
      'Minden állításhoz jelöld meg, melyik forrásrészletre támaszkodsz.',
      'Ha több, eltérő dátumú forrás van, a frissebbet részesítsd előnyben, és jelezd a dátumot.',
    ].join(' '),
  },

  limits: {
    maxQuestionChars: 1000,
    requestsPerMinutePerIp: 20,
  },
};
```

---

## 12. Open questions (awaiting decision, but not blocking round 1)

- **Choice of the concrete LLM and embedding provider** (based on price/Hungarian quality) —
  the interface is interchangeable, so this can be adjusted later too.
- **OCR solution:** local Tesseract (`hun`) vs. cloud OCR — the proportion of scanned decisions
  decides; Tesseract is enough to start.
- **Hybrid search fusion:** RRF vs. weighted score — let's experiment on the real
  corpus.
- **WordPress ingestion method:** the `/dokumentumok` menu loads the links via JS; if the
  static HTML is not enough, whether a headless browser (e.g. Playwright) is needed for the adapter.
- **Hosting:** where the backend (Node server) and the frontend (static) go — it affects
  the deploy pipeline.
