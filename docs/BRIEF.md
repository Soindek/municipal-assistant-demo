# Önkormányzati Ügysegéd — `municipal-assistant` (Claude Code brief, 1. kör)

> A termék neve **generikus**: `municipal-assistant` (magyarul „Önkormányzati Ügysegéd”).
> **Vácrátót az első bérlő (MVP tenant)**, nem maga a termék. Minden Vácrátót-specifikus
> dolog a két varrat mögé kerül (4. pont).

> Ezt a fájlt add oda a Claude Code sessionnek kiindulásként. A prózás magyarázat
> magyarul van, a kód és az azonosítók angolul (a repo nyelve). Az 1. kör konkrét
> szállítandóit a 10. pont sorolja fel.

---

## 1. Mit építünk (cél)

Egy beágyazható chat-webalkalmazás, amely egy önkormányzat hivatalos dokumentumai
alapján válaszol a lakosok szabad szöveges kérdéseire, **forrásmegjelöléssel**
(pl. „mennyi a kommunális adó?” → válasz + a vonatkozó rendelet linkje/oldala).

A felület letisztult, barátságos chat. A háttérben RAG (retrieval-augmented
generation) fut egy olcsó LLM-mel. A dokumentumok időről időre frissülnek, ezt egy
ütemezett betöltő pipeline tartja naprakészen.

**MVP: Vácrátót.** Forrás: https://vacratot.hu/dokumentumok/ (kategóriákba rendezett
PDF-ek: Rendeletek, Jegyzőkönyvek, Polgármesteri/HVB határozatok, Nyomtatványok,
Szerződések, Településrendezési tervek, Hírmondó; plusz egy Google Drive „Üvegzseb”
mappa és az njt.hu hatályos rendeletei). A Rendeletek közt van pl. a kommunális adó.

**Fontos megkötés: hordozhatóság.** Más önkormányzatok is átvehetik enyhe fejlesztői
testreszabással. Ezért minden településspecifikus dolog két jól körülhatárolt
„varrat” mögé kerül (4. pont), a többi kód semmit nem tud Vácrátótról.

A beágyazás célja a `https://vacratotikozosseg.hu/` WordPress-oldal egy aloldala
(pl. `/ugyseged`), iframe-ként.

---

## 2. Tech stack (fix döntések)

- **Frontend:** Angular 21 (TypeScript). Iframe-be ágyazható.
- **Backend:** Node + Express, **TypeScript**.
- **Adatbázis:** PostgreSQL + `pgvector`. **Hibrid keresés** (szemantikus vektor +
  magyar full-text), egyetlen DB-ben.
- **Streaming:** SSE a chat-válaszhoz.
- **Monorepo:** npm workspaces (`frontend` / `backend` / `shared`). NEM Nx, nem Turbo —
  ekkora projekthez felesleges.
- **Embedding:** többnyelvű modell (magyar miatt), pl. OpenAI `text-embedding-3-small`
  (1536 dim). Csereszabatos interfész mögött.
- **LLM:** olcsó, magyarul jó modell (pl. Gemini Flash vagy GPT-4o/4.1-mini osztály).
  Csereszabatos provider mögött.
- **Titkok:** API-kulcsok kizárólag környezeti változóból (`.env`), SOHA nem a
  tenant-config fájlban.

A betöltő pipeline a kérési úttól függetlenül fut (külön belépési pont / cron worker),
csak a DB-n keresztül érintkeznek.

---

## 3. Architektúra dióhéjban (két folyamat)

**Betöltés (offline, ütemezett):**
forrás-adapter (felfedezés + letöltés) → PDF szövegkinyerés (szkennelt PDF-nél OCR,
magyar nyelvi csomag) → darabolás (a rendeletek `§` szerkezetét követve, ahol lehet) →
embedding → upsert a vektor-DB-be. Csak az új/megváltozott dokumentumokat dolgozza fel
(változásfigyelő token alapján).

**Lekérdezés (online):**
felhasználó kérdése → (követő kérdéseknél: olcsó LLM-hívás, ami a beszélgetésből önálló
keresési kérdést gyárt) → hibrid keresés top-k → a találatok kontextusként az LLM-be
szigorú rendszerprompttal → SSE-streamelt válasz + a végén a források listája.

---

## 4. A két varrat (ettől hordozható)

Minden, ami településspecifikus, EBBE a kettőbe kerül; minden más általános mag.

1. **`DocumentSource` adapter** — az egyetlen mélyen oldalspecifikus rész. Felel a
   dokumentumok felfedezéséért és letöltéséért. A letöltéstől lefelé minden lépés
   egységes formátummal dolgozik, és nem tudja, honnan jött az adat. (Interfész: 11. pont.)

2. **`TenantConfig`** — arculat, beágyazási origin (CORS), kategória-taxonómia,
   forrás-leírók, RAG-paraméterek, rendszerprompt-sablon, limitek. (Típus: 11. pont.)

Egy új település indítása: új config-fájl + (ha kell) új adapter + deploy.

---

## 5. Repo-struktúra (monorepo)

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

## 6. Adatmodell (PostgreSQL + pgvector)

> Az embedding dimenziója a választott modelltől függ (text-embedding-3-small = 1536).
> Most **egy-bérlős** (külön DB/telepítés településenként), ezért NINCS `tenant_id`.
> Ha később többbérlős lesz, ide jön egy `tenant_id` oszlop + kötelező szűrés.

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

A hibrid keresés a `tsv` (GIN) és az `embedding` (HNSW) eredményeit egyesíti
(pl. RRF — reciprocal rank fusion, vagy súlyozott pontszám).

---

## 7. API

- `POST /api/ask` — bemenet: `{ question: string, history?: ChatTurn[] }`.
  Kimenet: **SSE** stream (válasz tokenek), a végén egy esemény a `Source[]` listával.
- `GET  /api/health` — készenléti/élő ellenőrzés.
- `POST /api/reindex` — (admin, védett) a betöltés kézi indítása.

A DTO-k a `shared`-ben élnek, így a frontend és a backend ugyanazt használja.

---

## 8. Kötelező óvintézkedések (guardrails)

- **Hallucináció ellen:** a rendszerprompt kategorikusan tiltja a kontextuson kívüli
  választ („ha nincs a forrásokban, mondd, hogy nem tudod, és irányítsd a hivatalhoz”).
  A retrievalnél `minScore` küszöb: ha nincs elég jó találat → „nem tudom” válasz.
- **Forráshűség:** az LLM csak a kapott, azonosítóval ellátott darabokra hivatkozhat;
  a UI ezekből épít kattintható forrást (dokumentum + oldal).
- **Hatályosság:** tárold a `published_at`-et, a frissebbet részesítsd előnyben; a
  `status`-szal jelölhető az elavult dokumentum. A hatályos rendeletekhez az njt.hu
  külön, megbízható forrás.
- **Jogi figyelmeztetés:** minden válasznál/UI-ban rövid disclaimer („tájékoztatás,
  nem hivatalos jogi tanács; kérjük, ellenőrizze a forrásban”).
- **Nyilvános végpont védelme:** IP-alapú rate limit + max üzenethossz (TenantConfig.limits).
- **Beágyazás:** CORS és `frame-ancestors` (CSP) csak a `TenantConfig.embed.allowedOrigins`
  origineket engedje. Iframe auto-magasság `postMessage`-dzsel (ne legyen belső görgetés).

---

## 9. Amit MOST NE építsünk

- NINCS többbérlős DB / `tenant_id` / bérlőszűrés. Egy-bérlős, config-vezérelt.
- NINCS admin-felület bérlőkezeléshez.
- NINCS plugin-rendszer az adapterekhez azon túl, hogy a `registry` név→factory leképez.
- Vácrátótot **konkrétan** építsük meg, fegyelmezetten a két varrat mögött. A további
  általánosítást akkor vegyük fel, amikor tényleg jön a második település.

---

## 10. Az 1. kör konkrét scope-ja (mit szállítson ez a session)

A cél egy **végponttól végpontig működő, vékony** vertikális szelet Vácrátótra.
Ha sok, bontsd lépésekre; az alábbi sorrend ajánlott.

1. **Monorepo scaffold:** npm workspaces, TypeScript, lint/format, `.env.example`,
   `docker-compose.yml` egy lokális Postgres + pgvector szolgáltatással.
2. **`shared` csomag:** a 11. pont típusai (DTO-k, `DocumentSource`, `TenantConfig`,
   `Source`, `ChatTurn`).
3. **DB:** a 6. pont sémája migrációként; egyszerű repository-k (documents, chunks).
4. **Config:** `config/default.ts` + `config/tenants/vacratot.ts`, zod-validációval.
5. **Ingestion:**
   - `registry` (adapter-név → factory),
   - `manual-upload` adapter (egy lokális mappából olvas — ezzel azonnal tesztelhető),
   - `wordpress-accordion` adapter (best-effort a vacratot.hu/dokumentumok struktúrára;
     ahol a JS-menü miatt nehéz, ott jól dokumentált TODO),
   - általános pipeline: download → PDF szövegkinyerés + OCR-fallback (magyar) →
     darabolás (`§`-tudatos, átfedéssel) → embedding → upsert (változás-token alapú skip).
6. **Backend API:** `/api/health`, majd `/api/ask` (SSE) a teljes RAG-úttal:
   (követő-kérdés átírás) → hibrid keresés → prompt → LLM → válasz + források +
   a 8. pont guardrailjei.
7. **Frontend:** minimális Angular chat-héj (kérdés-küldés, streamelt válasz
   megjelenítése, források listája), iframe-be ágyazhatóan, auto-magassággal.

**Minimum első commit (ha nagyon szűkíteni kell):** 1–5 + `/api/ask` happy path.
A frontend és a finomítások jöhetnek a 2. körben.

Adj rövid README-t a futtatáshoz (lokális Postgres, env-kulcsok, `seed`/`reindex`,
dev szerver).

---

## 11. Kód — `shared` típusok, `DocumentSource`, `TenantConfig`

> Ezek a `shared/src/`-be kerülnek. A kommentek magyarul, hogy a szándék egyértelmű legyen.

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
      'Üdvözlöm! Vácrátót hivatalos dokumentumai alapján segítek. Miben lehetek a segítségére?',
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

## 12. Nyitott kérdések (döntésre vár, de nem blokkolja az 1. kört)

- **Konkrét LLM- és embedding-szolgáltató** kiválasztása (ár/magyar minőség alapján) —
  az interfész csereszabatos, így ez később is állítható.
- **OCR-megoldás:** lokális Tesseract (`hun`) vs. felhős OCR — a szkennelt határozatok
  aránya dönti el; kezdésnek Tesseract elég.
- **Hibrid keresés egyesítése:** RRF vs. súlyozott pontszám — kísérletezzünk a valós
  korpuszon.
- **WordPress betöltés módja:** a `/dokumentumok` menü JS-sel tölti a linkeket; ha a
  statikus HTML nem elég, kell-e fejléc nélküli böngésző (pl. Playwright) az adapterhez.
- **Hosting:** hova kerül a backend (Node-szerver) és a frontend (statikus) — befolyásolja
  a deploy pipeline-t.
