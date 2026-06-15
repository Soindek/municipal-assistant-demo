# Döntésnapló (ADR-lite)

A projekt fontosabb technikai és architekturális döntései, tömören. Könnyített
ADR-formátum (Architecture Decision Record): döntésenként mit választottunk, milyen
problémára válaszol, miért, mi helyett, és mi a státusz.

A tartalom a kódból, a függőségekből, a configból és a commit-előzményekből van
levezetve. Ahol az indoklás nem volt biztosan kiolvasható, ott `> TODO` jelzi, hogy
megerősítésre vár — szándékosan nem találtunk ki indoklást.

> **Konvenció:** a „Miért" és „Alternatíva" mezőket csak akkor töltöttük ki, ha a
> repóból ténylegesen következik. Inkább hiányos és pontos, mint teljes és kitalált.

---

## 1. PostgreSQL + pgvector egyetlen adattárként

- **Döntés:** A dokumentumok, chunkok, beágyazások (`vector(1536)`), full-text index és
  a kérdésnapló mind egyetlen PostgreSQL-ben él, a `pgvector` kiterjesztéssel
  (`pgvector/pgvector:pg16`, lásd [docker-compose.yml](../docker-compose.yml),
  [001_init.sql](../backend/src/db/migrations/001_init.sql)).
- **Kontextus:** A RAG-hoz vektoros hasonlóságkeresés kell, de relációs adat (források,
  státusz, naplók) és magyar full-text is. A BRIEF 6. pontja ezt írta elő.
- **Miért:** Egy adattár elég — a relációs, a full-text és a vektoros igény mind
  Postgresből kiszolgálható, így nincs külön szinkronizálandó rendszer.
- **Alternatíva:** Dedikált vektoradatbázis (pl. Pinecone/Qdrant) a relációs DB mellett —
  egy második rendszer üzemeltetése és szinkronja, az MVP-hez felesleges.
- **Státusz:** Érvényes.

---

## 2. Hibrid keresés (full-text + vektor), RRF-fúzióval és frissesség-súlyozással

- **Döntés:** A keresés egyetlen SQL-ben egyesíti a szemantikus (pgvector koszinusz,
  HNSW index) és a magyar full-text (`to_tsvector('hungarian', …)`, GIN index)
  találatokat **Reciprocal Rank Fusion**-nel, majd enyhe **frissesség-súlyozást** ad rá
  (lásd [search.ts](../backend/src/retrieval/search.ts), commit `b4b09c8`).
- **Kontextus:** A tisztán szemantikus keresés elveszti a pontos kifejezéseket/számokat
  (pl. „kommunális adó", határozatszámok), a tisztán full-text pedig a parafrázist.
- **Miért:** A két keresés egymás vakfoltját fedi; az RRF rang-alapú, így nem kell a
  különböző skálájú pontszámokat normalizálni. A frissesség-boost a hatályosabb
  dokumentumot hozza előre, amikor több, eltérő dátumú forrás is illeszkedik.
- **Alternatíva:** Súlyozott pontszám-összegzés (a BRIEF 12. pontja ezt is felvetette) —
  skálázás/normalizálás kérdéses; az RRF egyszerűbb és robusztusabb a rangokon.
- **Státusz:** Érvényes.

---

## 3. `DocumentSource` adapter-absztrakció (varrat #1)

- **Döntés:** Minden mélyen oldalspecifikus rész (felfedezés + letöltés) egy közös
  `DocumentSource` interfész mögé kerül (`list()` + `fetch()`); a betöltési pipeline
  csak az interfészt ismeri (lásd [shared](../shared/src/), `registry.ts`,
  `pipeline.ts`, és az adapterek a `backend/src/ingestion/sources/`-ban).
- **Kontextus:** Minden település máshogy publikál (WordPress DLP, njt.hu, kézi feltöltés);
  a magnak ettől függetlennek kell maradnia.
- **Miért:** Új település indítása = új config + (ha kell) új adapter, a mag érintése
  nélkül. A pipeline (chunkolás, embedding, upsert, OCR) így forrás-agnosztikus.
- **Alternatíva:** Forrásspecifikus logika közvetlenül a pipeline-ban — nem skálázható
  több településre, sérti a bérlő-agnosztikus magot.
- **Státusz:** Érvényes. (Élő adapterek: `manual-upload`, `dlp-library`, `njt-decrees`,
  illetve a registryben maradt `wordpress-accordion`.)

---

## 4. Egy-bérlős, config-vezérelt felállás (varrat #2)

- **Döntés:** Bérlőnként külön deploy; a séma **nem** tartalmaz `tenant_id`-t
  ([001_init.sql](../backend/src/db/migrations/001_init.sql): „Single-tenant deployment").
  Minden településspecifikus beállítás egy `TenantConfig`-ban van, env-ből kiválasztva
  (`loadTenantConfig(env.TENANT_ID)`); az MVP bérlő:
  [vacratot.ts](../config/src/tenants/vacratot.ts).
- **Kontextus:** Egy önkormányzati ügysegéd kell előbb működésre bírni, tiszta adat- és
  konfigurációs izolációval, anélkül hogy a többbérlős komplexitást előre felvállalnánk.
- **Miért:** Az egy-bérlős deploy egyszerű és természetes izolációt ad (külön DB/példány
  településenként); a config-varrat a branding/források/RAG-paramétereket egy helyre
  zárja, így a mag tiszta marad.
- **Alternatíva:** Többbérlős, közös DB `tenant_id` oszloppal — minden lekérdezést szűrni
  kellene, és a hibázás kockázata (adatszivárgás bérlők közt) nagyobb; az MVP-hez halasztva.
- **Státusz:** Érvényes (a többbérlős mód halasztva).

---

## 5. Kurált DLP-feed a `wp/v2/media` helyett

- **Döntés:** A vacratot.hu dokumentumai a **Document Library Pro** kurált listából
  jönnek (admin-ajax `dlp_fetch_table`, mappánként = kategóriánként), nem a
  `wp/v2/media` REST-könyvtárból (lásd
  [dlp-library.ts](../backend/src/ingestion/sources/dlp-library.ts), config `trustCategory`,
  commit `0adfd58`).
- **Kontextus:** A média-könyvtár nyers fájllistát ad kategória és kurálás nélkül; a
  `/dokumentumok/` oldal viszont mappákba (Rendeletek, Jegyzőkönyvek, …) rendezett,
  emberek által gondozott listát mutat, külső linkekkel (njt, Drive) is.
- **Miért:** A DLP-mappa **maga a kategória** (nincs szükség tartalom-heurisztikára,
  `trustCategory: true`), a lista kurált (nincs média-könyvtár-zaj), és a külső linkes
  tételeket is tartalmazza.
- **Alternatíva:** `wp/v2/media` REST — médiakönyvtár-zaj, hiányzó valódi kategóriák, a
  külső linkek kimaradnak. (A régi `wordpress-accordion` adapter a registryben maradt, de
  a Vácrátót-config már a `dlp-library`-t használja.)
- **Státusz:** Érvényes (felülírja a korábbi `wp/v2/media` megközelítést).

---

## 6. Szkennelt PDF kezelése: `needs_ocr` státusz + lokális `tesseract.js`

- **Döntés:** Ha nincs kinyerhető szövegréteg, a dokumentum nem esik ki: `needs_ocr`
  státuszt kap (commit `77e3395`), és ha az OCR engedélyezett, a magyar **`tesseract.js`**
  futtatja le (PDF→kép render `@napi-rs/canvas`-szal), env-kapcsolóval
  (`OCR_ENABLED`, `OCR_MAX_PAGES`, `OCR_VIEWPORT_SCALE`) — lásd
  [ocr.ts](../backend/src/ingestion/ocr.ts), [run.ts](../backend/src/ingestion/run.ts),
  commit `6432235`.
- **Kontextus:** A jegyzőkönyvek/határozatok nagy része szkennelt kép; ezeket nem szabad
  üres/szemét szövegként betölteni, de nyomon kell tudni követni és újra feldolgozni.
- **Miért:** A `needs_ocr` jelölés láthatóvá és újra-indexelhetővé teszi a szkennelteket
  (a nem-`active` dokumentumokat a betöltés mindig újrafeldolgozza). A `tesseract.js`
  lokális és ingyenes, és a `@napi-rs/canvas` miatt **nincs rendszerszintű függőség**
  (hordozható). A cél a kereshetőség/idézhetőség, nem a tökéletes átirat.
- **Alternatíva:** (a) A szkennelteket csendben eldobni — elvesztett tartalom, nyom nélkül.
  (b) Felhős OCR — költség és adatvédelmi kérdés. (c) Natív Tesseract — rendszerszintű
  függőség a deployon. A hordozható `tesseract.js`-t választottuk.
- **Státusz:** Érvényes.

---

## 7. njt.jog.gov.hu mint a rendeletek hiteles forrása (időzítés + supersede)

- **Döntés:** A **hatályos** önkormányzati rendeletek hiteles forrása a Nemzeti
  Jogszabálytár (`njt-decrees` adapter); sikeres betöltés után `authoritativeFor:
  ['rendeletek']` révén **felülírja** (`superseded`) a többi forrás (pl. a vacratot.hu
  szkennelt) rendeleteit (lásd [run.ts](../backend/src/ingestion/run.ts) supersede-logika,
  config, commit `b55ec06`). Az integráció a teljes pipeline (manual-upload + WordPress)
  beüzemelése után, egy későbbi körben készült el.
- **Kontextus:** A vacratot.hu rendeletei jórészt szkenneltek (zajos OCR); az njt
  hatályos, géppel olvasható, §-tagolt szöveget ad.
- **Miért:** Az njt a hivatalos, hatályos szöveg → ez legyen a hiteles forrás, és írja
  felül a gyengébb minőségű másolatokat. A `requestDelayMs: 3000` + exponenciális
  backoff (commitok `7a6126f`, `23c1214`) azért kell, mert az njt agresszíven rate-limitel
  (HTTP 500 burst alatt); a sikertelen dokumentumok nem kerülnek upsertre, így az
  újrafuttatás konvergál.
- **Alternatíva:** A rendeleteket a vacratot.hu szkennelt PDF-jeiből betölteni — vegyes
  OCR-minőség, nem feltétlenül hatályos. Ezért a DLP-forrásból a `Rendeletek` mappa
  kifejezetten ki van zárva (`excludeCategories`), az njt javára.
- **Státusz:** Érvényes. (Korábban egy későbbi körre halasztva; mostanra megvalósult és
  hiteles forrás.)
- **Megjegyzés:** Egyes hálózatokról az njt blokkolhatja az automata kéréseket — a
  betöltés onnan fut, ahonnan az njt elérhető.

---

## 8. Olcsó LLM + embedding modell, csereszabatos interfész mögött

- **Döntés:** `chatModel = gpt-4.1-mini`, `embeddingModel = text-embedding-3-small`
  (1536 dim), egy cserélhető LLM-interfész mögött (lásd
  [vacratot.ts](../config/src/tenants/vacratot.ts) `rag`, [openai.ts](../backend/src/llm/openai.ts)).
- **Kontextus:** A RAG sok embeddinget és válasz-streamet igényel; a magyar nyelvi
  minőség és a költség is számít. A BRIEF 2. pontja és egy menet közbeni döntés rögzítette.
- **Miért:** A configban szereplő indoklás szerint olcsó modellek, amelyek magyarul is jól
  teljesítenek; az embedding (`text-embedding-3-small`) költsége elhanyagolható. Az
  interfész csereszabatos, így a szolgáltató/modell később állítható.
- **Alternatíva:** Nagyobb modellek (pl. `gpt-4.1`, `text-embedding-3-large`) — magasabb
  költség; vagy lokális modellek — bizonytalan magyar minőség. Az interfész miatt ez a
  választás visszafordítható.
- **Státusz:** Érvényes.

---

## 9. Kontextuális chunkok (a cím a beágyazott szövegben)

- **Döntés:** A beágyazott szöveg elé kerül a dokumentum címe
  (`buildEmbedText(title, content)`), és a top-K 8-ra nőtt, dátum-tippel a promptban
  (lásd [embed-text.ts](../backend/src/ingestion/embed-text.ts), commit `310edbe`).
- **Kontextus:** Egy dátumra szűrő kérdés (pl. „mi volt 2025. július 28-án") elvétette a
  jegyzőkönyvet, mert a dátum csak a címben volt, a chunk szövegében nem — a sok njt-rendelet
  pedig kiszorította a top-K-ból.
- **Miért:** Ha a cím (és az abban lévő dátum/típus) a beágyazott szövegben is benne van,
  a chunk a cím alapján is megtalálható.
- **Alternatíva:** Csak a nyers chunk-szöveg beágyazása — a címben lévő jel (dátum, típus)
  elveszik.
- **Státusz:** Érvényes.

---

## 10. Deploy / hosting irány

- **Döntés:** `> TODO: megerősítésre vár.` A repóban **nincs** deploy-artefaktum
  (nincs `Dockerfile`, `Caddyfile` vagy `.github/workflows/`), és a BRIEF 12. pontja a
  hostingot kifejezetten nyitott kérdésként sorolja fel.
- **Kontextus:** A backend egy Node-szerver (Express, SSE), a frontend statikus Angular
  build; el kell dönteni, hova kerülnek és milyen pipeline-nal.
- **Miért:** `> TODO: indoklás megerősítése.` (A szóban felmerült irány **Hetzner + Docker
  + Caddy + GitHub Actions**, de ennek a repóban egyelőre nincs nyoma — szándékosan nem
  rögzítjük megvalósított döntésként.)
- **Alternatíva:** `> TODO: a konkrét alternatívák a hosting-döntéssel együtt rögzítendők.`
- **Státusz:** Halasztott.

---

## 11. njt rendelet-törzs kinyerése `<div>`-ből is, nem csak `<p>`-ből

- **Döntés:** A `parseDecreeText` a `#jogszab` elem teljes szövegét veszi ki blokk-szintű
  tördeléssel (egy menetben), nem csak a `h1/h2/p` elemeket.
- **Kontextus:** Az njt **újabb** rendeletei a törzset `<p>`-be teszik, a **régiek** (pl. a
  2004/2011-es adórendeletek) `<div>`-be. A régi parse csak `h1/h2/p`-t olvasott, ezért 139
  rendeletből **56 csak címmel** került be (~109 karakter), elveszítve a tényleges
  adómértékeket.
- **Miért:** A `<div>`-törzs egyetlen menetben (`#jogszab` teljes szövege, blokk-tördeléssel)
  duplikáció nélkül kinyerhető, és a `<p>`-alapúakat sem rontja el.
- **Alternatíva:** Csak `<div>` hozzáadása a szelektorhoz — a beágyazott `<div>`-ek miatt
  duplikálná a szöveget.
- **Státusz:** Érvényes. Igazolva: kommunális adó „12.000,-Ft/adótárgy/év", építményadó
  „220,-Ft/m2", telekadó „20 Ft/m2"; a `<p>`-alapú nagy rendeletek változatlanok.

---

## 12. Retrieval-minőség rétegekben — egy tünet, két (három) külön probléma

- **Döntés:** A retrieval-minőséget **rétegenként** javítjuk, és a különböző okokat külön
  kezeljük; nem húzunk egyből „nagy megoldást" egy tünetre.
- **Kontextus:** A „mennyi a kommunális/építményadó?" kérdések rossz/üres választ adtak. A
  vizsgálat három, **különböző természetű** réteget tárt fel:
  1. **Adat-hiány:** a hiteles rendeletek törzse hiányzott (lásd 11. pont) — *adatprobléma*,
     amit retrieval-hangolással nem lehetett volna megoldani.
  2. **Pool-vágás:** az adat javítása után is elsüllyed a hiteles forrás, mert a magas
     frekvenciájú témaszavak („adó", „bérleti") miatt az archív tömeg kiszorítja a
     rerank-ablak előtt.
  3. **HNSW post-filter:** a kategória-szűrt („csak rendeletek/oldalak") szemantikus keresés
     éhezik — a HNSW a top-`ef_search` globálisan legközelebbit adja, és UTÁNA szűr
     kategóriára, így alig marad hiteles jelölt.
- **Miért:** A rétegenkénti haladás derítette ki, hogy a tünet jó része **adathiba** volt; a
  korai „nagy retrieval-megoldás" elfedte volna ezt, és rossz adaton hangoltunk volna.
- **Alternatíva:** Egyből komplex reranker a tünetre — vakon, hibás adaton.
- **Státusz:** Részben érvényes. A 11. pont (adat) **javítva**; a 2–3. réteg (pool-vágás,
  filtered-KNN) **dedikált, tervezett körre** vár (filtered-KNN ef_search/exact +
  query-kulcskifejezés→cím-egyezés vagy cross-encoder), friss main fölött, before/after
  méréssel. A `feat/retrieval-rerank` PR addig nyitva marad.
