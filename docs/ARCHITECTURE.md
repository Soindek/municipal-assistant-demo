# Architektúra — Önkormányzati Ügysegéd (`municipal-assistant`)

Ez a dokumentum új fejlesztőknek szól: mappánként a felelősségek, a belépési
pontok, és a két fő folyamat (betöltés és lekérdezés) lépésről lépésre, megnevezve,
melyik fájl mit csinál. A részletes terméki specifikáció: [BRIEF.md](BRIEF.md).

## Áttekintés

A termék egy beágyazható chat, amely egy önkormányzat **hivatalos dokumentumai
alapján**, forrásmegjelöléssel válaszol. A háttérben RAG (retrieval-augmented
generation) fut: a dokumentumokat egyszer betöltjük (offline pipeline), a
kérdésekre pedig hibrid kereséssel + LLM-mel válaszolunk (online út).

A kód **bérlő-agnosztikus**; minden településspecifikus dolog két „varrat" mögé
kerül: a **`DocumentSource` adapter** (honnan jönnek a dokumentumok) és a
**`TenantConfig`** (arculat, források, RAG-paraméterek). Az MVP bérlő: Vácrátót.

A repó **npm workspaces** monorepo, négy csomaggal: `shared`, `config`, `backend`,
`frontend`.

## Mappánkénti felelősség

### `shared/` — közös típusok (semmilyen logika)
A frontend és a backend közös szerződése; nincs benne futtatható logika, csak típus.
- `src/dto.ts` — a chat DTO-i: `ChatTurn`, `Source` (forrásmegjelölés), `AskRequest`,
  és az SSE `AskEvent` uniója (`token` / `sources` / `done` / `error`).
- `src/document-source.ts` — a **#1 varrat** típusai: `SourceDocument` (nyers
  forrás-leíró), `FetchedContent` (letöltött bájtok), `DocumentSource` (a `list()` +
  `fetch()` interfész), `DocumentSourceFactory`, és az injektált `SourceLogger`.
- `src/tenant-config.ts` — a **#2 varrat** típusa: `TenantConfig` (arculat, embed-
  originek, kategóriák, `categoryKeywords`, források, RAG-paraméterek, limitek) és
  a `SourceDescriptor`.

### `config/` — tenant-betöltő (#2 varrat)
- `src/schema.ts` — a `TenantConfig` zod-sémája (a merge utáni, kész configot validálja).
- `src/default.ts` — józan magyar önkormányzati alapértékek + a **rendszerprompt-sablon**
  (hallucináció-tiltás, idézési szabály).
- `src/deep-merge.ts` — `default <- tenant` mély összefésülés.
- `src/tenants/vacratot.ts` — Vácrátót konkrét configja (kategóriák, források,
  modellek: `gpt-4.1-mini` + `text-embedding-3-small`).
- `src/index.ts` — `loadTenantConfig(id)`: statikus tenant-regiszter → merge → zod-validáció.

### `backend/` — API, betöltés, DB, RAG, OCR
- `src/server.ts` — **a HTTP szerver belépési pontja** (lásd lent).
- `src/env.ts` — a környezeti változók zod-validációja; a `.env`-et a repó gyökeréből tölti.
- `src/paths.ts` — a repó gyökér-útja (a `.env` és a feltöltési/cache mappák feloldásához).
- `src/logger.ts` — egyszerű konzol-logger (a `SourceLogger` implementációja).
- `src/db/`
  - `pool.ts` — megosztott PostgreSQL connection pool (`DATABASE_URL`).
  - `migrate.ts` — könnyű migrációs runner (sorszámozott `.sql` fájlok, `schema_migrations`).
  - `migrations/001_init.sql` — a séma: `documents`, `chunks` (`vector(1536)` + magyar
    `tsvector`), `query_log`; HNSW + GIN indexek.
  - `repositories/documents.ts` — `findByExternalId` (változásfigyelés), `upsertDocument`
    (státusszal), `supersedeOtherSources` (hiteles forrás felülírja a többit egy kategóriában).
  - `repositories/chunks.ts` — `replaceChunks` (törlés + beszúrás tranzakcióban),
    `deleteChunksForDocument`, vektor-literál képzés.
  - `repositories/query-log.ts` — `insertQueryLog` (minőségméréshez).
- `src/llm/` — **csereszabatos** LLM/embedding réteg.
  - `types.ts` — `EmbeddingClient`, `ChatClient` (`streamChat` + `complete`) interfészek.
  - `openai.ts` — OpenAI implementáció (a kulcs KIZÁRÓLAG env-ből).
  - `index.ts` — `createLlmClients(config)`: a config modellneveiből épít klienseket.
- `src/ingestion/` — **a betöltő pipeline** (lásd a folyamatot lent).
  - `run.ts` — a betöltés **belépési pontja** (CLI: `seed`/`reindex`).
  - `registry.ts` — adapter-név → factory leképezés (#1 varrat bekötése).
  - `pipeline.ts` — az általános, forrás-agnosztikus pipeline (`ingestSource`).
  - `extract.ts` — PDF (pdfjs) és sima szöveg kinyerése; jelzi, ha „szkenneltnek tűnik".
  - `ocr.ts` — szkennelt PDF → OCR: pdfjs render `@napi-rs/canvas`-szal → `tesseract.js` (magyar).
  - `chunk.ts` — `§`-tudatos darabolás átfedéssel.
  - `embed-text.ts` — az embedding bemenete: dokumentum-cím + chunk (kontextus a kereséshez).
  - `categorize.ts` — tartalom-alapú kategorizálás (`categoryKeywords` a configból).
  - `recategorize.ts`, `reembed.ts` — karbantartó scriptek (meglévő dokumentumok
    újrasorolása / újra-embeddelése, újraletöltés nélkül).
  - `sources/` — **az adapterek (#1 varrat)**, mindegyik egy `DocumentSource`:
    - `manual-upload.ts` — helyi mappából (`data/uploads/`) olvas (gyors teszt).
    - `dlp-library.ts` — a `vacratot.hu/dokumentumok` **kurált** Document Library Pro
      listája (admin-ajax), valódi kategóriákkal és külső linkekkel.
    - `njt-decrees.ts` — a **hatályos** önkormányzati rendeletek + indokolások +
      mellékletek a Nemzeti Jogszabálytárból.
    - `wordpress-accordion.ts` — régi WP REST media megoldás (a registryben marad, de a
      Vácrátót config már a `dlp-library`-t használja).
- `src/retrieval/` — a keresés és a prompt összeállítása.
  - `search.ts` — `hybridSearch`: szemantikus (pgvector koszinusz) + magyar full-text
    (GIN, `ts_rank` hossz-norm) RRF-fúzióval, frissesség- és kategória-súllyal; csak
    `status='active'`. `authoritativeShortlist`: garantált hiteles-jelölt (`rendeletek`/
    `oldalak`) filtered-KNN-nel (emelt `hnsw.ef_search`) + cím-egyezéssel.
  - `prompt.ts` — rendszerprompt, `[Forrás N]` kontextus-blokk, követő-kérdés átírás
    (`rewriteFollowUp`), kulcskifejezés-kinyerés (`extractKeyphrase`), tekintély-tudatos
    rerank (`rerankChunks`), a használt forrásokra szűrés (`selectUsedChunks`) + deduplikált
    `Source[]` (`buildSources`).
- `src/api/` — a HTTP réteg.
  - `app.ts` — `createApp(deps)`: middleware + route-ok összerakása.
  - `deps.ts` — `ApiDeps` (config + LLM-kliensek + env, egyszer felépítve induláskor).
  - `middleware.ts` — `corsAndCsp` (csak az engedett originek), `rateLimit` (IP-alapú).
  - `sse.ts` — SSE-fejlécek + `sendEvent` (tipizált `AskEvent` kiírása).
  - `handlers.ts` — a végpontok: `health`, `config`, **`ask`** (a teljes RAG-út), `reindex`.

### `frontend/` — Angular 21 chat UI
Beágyazható (iframe), zoneless + signalek. A brandinget a `GET /api/config`-ból tölti.
- `src/app/api.ts` — `AssistantApi`: `getConfig()` + `ask()` (a POST `/api/ask` SSE-streamjét
  `fetch` + `ReadableStream` segítségével fogyasztja).
- `src/app/app.ts` / `app.html` / `app.css` — a chat-komponens (üzenetek signalként,
  streamelt válasz, források, iframe auto-magasság `postMessage`-dzsel).
- `proxy.conf.json` — dev közben a `/api`-t a backendre proxyzza.

## Belépési pontok

- **Backend indulás:** `backend/src/server.ts` → `main()`: beolvassa az env-et
  (`getEnv`), betölti a tenant configot (`loadTenantConfig(env.TENANT_ID)`), felépíti az
  LLM-klienseket (`createLlmClients`), létrehozza az Express appot (`createApp`), és
  `app.listen(PORT)`. (Indítás: `npm run dev`.)
- **`/api/ask` (a lekérdezés):** `backend/src/api/handlers.ts` → `createAskHandler`.
- **Betöltés:** `backend/src/ingestion/run.ts` → `run()` (CLI: `npm run seed` /
  `npm run reindex [-- --source=<adapter>]`).
- **DB séma:** `backend/src/db/migrate.ts` (`npm run migrate`).
- **Frontend:** `frontend/src/main.ts` → `App` komponens (`npm run dev:frontend`).

## Adatmodell (dióhéjban)

Egy `documents` sor egy forrás-dokumentum (cím, `source_name`, `external_id`,
`category`, `source_url`, `status`, `change_token`). Egy `chunks` sor egy
szövegdarab a dokumentumból: `content` (tiszta szöveg), `embedding vector(1536)`,
`tsv` (magyar full-text), `section_ref` (pl. „12. §"), `page_number`. A
`query_log` a kérdéseket naplózza. A `documents.status` lehet `active`,
`needs_ocr` (szkennelt, még szöveg nélkül), vagy `superseded` (hitelesebb forrás
kiváltotta) — a keresés csak az `active`-ot nézi.

## 1. folyamat — Betöltés (offline, `ingestion/run.ts`)

A betöltés a kérési úttól függetlenül fut, és csak a DB-n keresztül érintkezik a
lekérdezéssel.

1. **Indulás (`run.ts`):** beolvassa az env-et és a tenant configot, felépíti az
   embedding-klienst, és — env-kapcsolótól függően — egy **OCR-hook**-ot és egy
   **kategorizáló-hook**-ot. Kiválasztja a feldolgozandó forrásokat
   (`config.sources`, opcionálisan `--source=` szűrővel).
2. **Adapter példányosítás (`registry.ts`):** a forrás-leíróból (`SourceDescriptor`)
   a megfelelő `DocumentSource` adaptert hozza létre.
3. **Általános pipeline (`pipeline.ts` → `ingestSource`)** — minden adapterre ugyanaz:
   1. `source.list(ctx)` — az adapter felsorolja a dokumentumokat (`SourceDocument`),
      lapozást/külső API-t maga kezel (pl. `dlp-library` az admin-ajax-ot).
   2. **Változásfigyelés:** `documents.findByExternalId` — ha a dokumentum már `active`
      és a `change_token` változatlan, kihagyja (nincs újraletöltés).
   3. `source.fetch(doc)` — az adapter letölti a bináris tartalmat (`FetchedContent`).
   4. **Szövegkinyerés (`extract.ts`):** PDF → pdfjs oldalanként; ha gyakorlatilag
      nincs szöveg → `likelyScanned`.
   5. **OCR (`ocr.ts`), ha szkennelt és van OCR-hook:** pdfjs az oldalt képpé
      rendereli (`@napi-rs/canvas`), majd `tesseract.js` (magyar) kinyeri a szöveget.
      OCR nélkül a dokumentum `needs_ocr` jelölést kap (chunk nélkül, kereshetetlen,
      de nyomon követhető).
   6. **Kategorizálás (`categorize.ts`), ha nem „trustCategory" forrás:** a kategóriát
      a kinyert szövegből finomítja (a kurált DLP-forrás kategóriáját viszont tiszteletben tartja).
   7. **Darabolás (`chunk.ts`):** `§`-tudatos chunkok átfedéssel.
   8. **Embedding (`embed-text.ts` + `llm`):** a beágyazott szöveg = dokumentum-cím +
      chunk (a cím így — pl. dátum — kereshetővé válik), kötegelve.
   9. **Tárolás:** `documents.upsertDocument` + `chunks.replaceChunks` (a vektor és a
      `tsv` is bekerül).
   10. **Felülírás (supersede):** ha egy forrás „authoritativeFor" egy kategóriára (pl.
       az `njt-decrees` a `rendeletek`-re), a betöltés végén a többi forrás azonos
       kategóriájú dokumentumait `superseded`-re állítja (`documents.supersedeOtherSources`).

Karbantartás újraletöltés nélkül: `recategorize.ts` (kategóriák újraszámolása a tárolt
szövegből) és `reembed.ts` (chunkok újra-embeddelése, ha az embedding-szöveg módja változott).

## 2. folyamat — Lekérdezés (online, `/api/ask`)

1. **Kérés:** a frontend (`frontend/src/app/api.ts`) POST-ol a `/api/ask`-ra, és az
   SSE-választ `fetch` + `ReadableStream`-mel olvassa.
2. **Validáció (`api/handlers.ts` → `createAskHandler`):** zod ellenőrzi a kérdést
   (max hossz a `TenantConfig.limits`-ből); az IP-rate-limit a `middleware.ts`-ben fut.
3. **Követő-kérdés átírása (`retrieval/prompt.ts` → `rewriteFollowUp`):** ha van
   beszélgetési előzmény, egy olcsó LLM-hívás önálló keresési kérdést gyárt belőle.
4. **Beágyazás + kulcskifejezés:** az `EmbeddingClient` a keresési kérdést vektorrá
   alakítja; párhuzamosan egy olcsó LLM-hívás (`prompt.ts` → `extractKeyphrase`) kivonja a
   kérdés témáját (pl. „kommunális adó") a hiteles cím-egyezéshez.
5. **Jelölt-keresés (két forrás → rerank-ablak):**
   - **általános hibrid pool** (`retrieval/search.ts` → `hybridSearch`): pgvector (koszinusz)
     + magyar full-text (GIN) RRF-fúzióval, frissesség- és **kategória-súllyal**,
     `ts_rank` hossz-normalizálással;
   - **garantált hiteles-shortlist** (`search.ts` → `authoritativeShortlist`): a
     `rag.authoritativeCategories` (`rendeletek`/`oldalak`) közül **filtered-KNN** megemelt
     `hnsw.ef_search`-csel + **kulcskifejezés→cím-egyezés** (csak valódi illeszkedésnél).
   A kettőt a handler **egyesíti** (dedup) — ez a rerank-ablak.
6. **Guardrail (`handlers.ts`):** ha az ablak legjobb koszinusz-hasonlósága a `minScore`
   alatt van (vagy üres) → kész „nem tudom" válasz, és vége.
7. **Rerank (`prompt.ts` → `rerankChunks`):** tekintély-tudatos LLM-rerank az ablakot
   relevancia szerint **top-K**-ra szűri. A garancia a hiteles forrás *behozatalára* szól,
   a végső sorrendet a rerank dönti.
8. **Prompt-összeállítás (`prompt.ts` → `buildAnswerMessages`):** rendszerprompt
   (hallucináció-tiltás, idézési szabály) + a számozott `[Forrás N]` kontextus-blokk + a kérdés.
9. **Válasz streamelése (`llm` → `streamChat`):** az LLM tokenjeit a `sse.ts`
   `token` eseményekként küldi.
10. **Idézés + források:** `prompt.ts` → `selectUsedChunks` a ténylegesen használt
    forrásokra szűr, `buildSources` dokumentumonként deduplikál → `sources` esemény, majd `done`.
11. **Naplózás:** a kérdés/átírt kérdés/válasz/talált chunkok a `query_log`-ba (best-effort).
12. **Megjelenítés (frontend):** a tokenek folyamatos szöveggé állnak össze, alattuk a
    források és a jogi disclaimer. (Az esetleges maradék `[Forrás N]` jelölést a frontend letakarítja.)

## Egy kérdés útja — „mennyi a kommunális adó?"

Kövessük végig konkrétan, mi történik, amikor a felhasználó beírja a chatbe, hogy
**„mennyi a kommunális adó?"** — a böngészőtől a forrásmegjelölt válaszig.

1. **A felhasználó beír és küld (frontend).** A szöveg a `draft` signalba kerül
   (`frontend/src/app/app.html` textarea). Enter vagy a Küldés gomb a komponens
   `send()` metódusát hívja (`frontend/src/app/app.ts`): ez összeállítja az eddigi
   beszélgetést `history`-ként, betesz egy felhasználói üzenetet és egy „készülő"
   asszisztens-buborékot, majd meghívja az `AssistantApi.ask("mennyi a kommunális
   adó?", history)`-t.
2. **A kérés elindul (frontend → backend).** Az `AssistantApi.ask`
   (`frontend/src/app/api.ts`) egy `POST /api/ask`-ot küld `{question, history}`
   JSON-nel. Dev közben a `proxy.conf.json` a `/api`-t a backendre (`:3001`) irányítja.
   A választ NEM várja meg egyben: a `ReadableStream`-et olvasva a `data:` SSE-kereteket
   `AskEvent`-ekké alakítja, és ahogy jönnek, továbbadja.
3. **A backend fogadja (`/api/ask`).** Az Express app (`backend/src/api/app.ts`) a
   POST `/api/ask`-ot előbb az IP-alapú `rateLimit` middleware-en (`middleware.ts`)
   engedi át, majd a `createAskHandler` kezelőhöz (`backend/src/api/handlers.ts`).
4. **Validáció + SSE-nyitás.** A handler zod-dal ellenőrzi a kérdést (nem üres, és a
   `TenantConfig.limits.maxQuestionChars` alatt van). Ha hibás → `400`. Ha jó, az
   `initSse` (`sse.ts`) beállítja az SSE-fejléceket, és egy `AbortController` figyeli,
   ha a kliens idő előtt bontana.
5. **Követő-kérdés átírás — most kimarad.** A `rewriteFollowUp` (`retrieval/prompt.ts`)
   üres `history`-nál visszaadja a kérdést változatlanul. (Ha pl. korábban a
   kommunális adóról kérdezett volna, és most azt írná, hogy „és mikor kell fizetni?",
   itt egy olcsó LLM-hívás csinálna belőle önálló keresési kérdést.)
6. **Beágyazás + kulcskifejezés.** A handler párhuzamosan futtatja az
   `EmbeddingClient.embed(["mennyi a kommunális adó?"])`-t (`llm/openai.ts`,
   `text-embedding-3-small` → 1536 dimenziós vektor) és az `extractKeyphrase`-t
   (`prompt.ts`) — utóbbi kivonja a témát: „kommunális adó".
7. **Jelölt-keresés (két forrás → rerank-ablak).** (a) `hybridSearch`
   (`retrieval/search.ts`): a **szemantikus** (`chunks.embedding` koszinusz, HNSW) és a
   **magyar full-text** (`chunks.tsv`, GIN, `ts_rank` hossz-normalizálással) listák **RRF**-
   fúziója, frissesség- és **kategória-súllyal** → általános pool. (b) `authoritativeShortlist`
   (`search.ts`): a `rendeletek`/`oldalak` közül **filtered-KNN** megemelt `hnsw.ef_search`-csel
   (a HNSW post-filter éhezés ellen) + **cím-egyezés** a „kommunális adó" kulcskifejezésre →
   ez garantálja, hogy a hiteles *kommunális adóról* szóló njt-rendelet bekerüljön. A kettőt a
   handler egyesíti (dedup) — ez a rerank-ablak.
8. **Guardrail.** Ha az ablak legjobb koszinusz-hasonlósága a `rag.minScore` (0.2) alatt van
   (vagy üres) → kész „ezt nem találom a dokumentumokban…" válasz, és vége. Itt van jó
   találat, megy tovább.
9. **Rerank.** A `rerankChunks` (`prompt.ts`) tekintély-tudatos LLM-rerankja az ablakot
   relevancia szerint **top-K** (8) chunkra szűri (a hiteles rendelet behozatala garantált, a
   sorrendet a rerank dönti).
10. **A prompt összeáll.** A `buildAnswerMessages` (`prompt.ts`) felépíti az
   üzeneteket: a **rendszerprompt** (a `TenantConfig.rag.systemPromptTemplate`-ből, a
   `{displayName}` behelyettesítve — tartalmazza a „kizárólag a forrásokból válaszolj"
   és az idézési szabályt), majd egy felhasználói üzenet, amelyben a `buildContextBlock`
   a találatokat számozott **`[Forrás N]`** blokkokká fűzi (cím, `§`, oldal +
   chunk-szöveg), végül maga a kérdés.
11. **LLM-hívás, streamelve.** A handler a `ChatClient.streamChat(messages, onToken)`-t
    hívja (`backend/src/llm/openai.ts`, `gpt-4.1-mini`). Ahogy érkeznek a tokenek, a
    `sse.ts` `sendEvent`-je `{type:'token', text}` eseményként küldi őket a kliensnek —
    pl. „A kommunális adó mértéke … 12.000 Ft évente …".
12. **Idézés + források + lezárás.** A `selectUsedChunks` (`prompt.ts`) a válasz alapján
    leszűri a ténylegesen használt chunkokra, majd a `buildSources` dokumentumonként
    deduplikált `Source[]`-t készít (cím, kategória, `source_url`, oldal, `§`) → `{type:'sources'}`,
    majd `{type:'done'}`.
13. **Naplózás.** A `logQuery` (`handlers.ts`) tűzd-és-felejtsd módon a `query_log`-ba
    írja a kérdést, az átírt kérdést, a választ és a talált chunk-id-kat.
14. **Megjelenítés (frontend).** Az `App.send()` ciklusa fogyasztja az eseményeket: a
    `token`-eket a `assistant.text` signalhoz fűzi (élő gépelés-érzet), a `sources`-t a
    buborék alá teszi kattintható linkként, a `done`-nál véglegesít. A felhasználó a
    folyamatos választ látja, alatta a **forrást** (a kommunális adó rendelet,
    `njt.jog.gov.hu/jogszabaly/…` linkkel) és a jogi disclaimert.

Röviden: `app.ts` → `api.ts` → `api/app.ts` → `handlers.ts` → (`prompt.rewriteFollowUp`)
→ `llm.embed` + `prompt.extractKeyphrase` → `search.hybridSearch` + `search.authoritativeShortlist`
→ (egyesített ablak) → `prompt.rerankChunks` → `prompt.buildAnswerMessages` → `llm.streamChat`
→ `prompt.selectUsedChunks` + `prompt.buildSources` → SSE → vissza a `app.ts`-be.

## Keresztmetsző elvek

- **Két varrat:** minden településspecifikus dolog a `DocumentSource` adapterek
  (`backend/src/ingestion/sources/`) és a `TenantConfig` (`config/tenants/`) mögött van;
  a mag (pipeline, retrieval, API) semmit nem tud egy konkrét településről.
- **Titkok:** az OpenAI-kulcs KIZÁRÓLAG env-ből (`OPENAI_API_KEY`), soha a configban.
- **Guardrailek:** `minScore` küszöb, kötelező forrásmegjelölés, disclaimer, IP-rate-limit,
  CORS + CSP `frame-ancestors` (csak az engedett beágyazó originek).
- **Hitelesség/hatályosság:** az `njt-decrees` a rendeletek hiteles forrása, és
  `supersede`-del kiváltja a kevésbé megbízható (pl. szkennelt) másolatokat.
- **Egy-bérlős:** nincs `tenant_id` a DB-ben; egy telepítés = egy település.
