# Önkormányzati Ügysegéd (`municipal-assistant`)

Beágyazható chat-webalkalmazás, amely egy önkormányzat **hivatalos dokumentumai
alapján**, forrásmegjelöléssel válaszol a lakosok kérdéseire. A háttérben RAG
(retrieval-augmented generation) fut hibrid kereséssel (PostgreSQL + `pgvector`
szemantikus + magyar full-text).

A termék **bérlő-agnosztikus**; minden településspecifikus dolog két „varrat" mögé
kerül: a `DocumentSource` adapter (forrás-felfedezés/letöltés) és a `TenantConfig`
(arculat, források, RAG-paraméterek). Az **MVP bérlő: Vácrátót**.

A részletes specifikáció: [docs/BRIEF.md](docs/BRIEF.md).

## Monorepo felépítés (npm workspaces)

```
municipal-assistant/
├─ shared/      # bérlő-agnosztikus típusok (DTO-k, DocumentSource, TenantConfig)
├─ config/      # config-betöltő + tenantok (varrat #2)  — config/tenants/vacratot.ts
├─ backend/     # Express API, ingestion pipeline, DB, RAG
└─ frontend/    # Angular chat UI (2. kör)
```

## Előfeltételek

- Node.js **>= 20.19**, npm **>= 10**
- Docker (a lokális Postgres + pgvector miatt)
- OpenAI API kulcs

## Beüzemelés

```bash
# 1) Függőségek
npm install

# 2) Környezeti változók
cp .env.example .env       # majd töltsd ki (legalább OPENAI_API_KEY)

# 3) Adatbázis (Postgres + pgvector dockerben)
npm run db:up

# 4) Séma migrálása
npm run migrate
```

### Titkok

Az OpenAI kulcs **kizárólag** a `.env`-ből (`OPENAI_API_KEY`) jön — soha nem kerül
kódba vagy a tenant-configba. A `.env` a `.gitignore`-ban van; csak a `.env.example`
verziózott.

## Futtatás

```bash
# Dokumentumok betöltése a helyi data/uploads mappából (manual-upload adapter)
npm run seed

# Vagy az összes konfigurált forrás újraindexelése
npm run reindex

# Backend dev szerver (SSE /api/ask)
npm run dev
```

### Gyors teszt

1. Tegyél néhány PDF-et a `data/uploads/` mappába.
2. `npm run seed` — betölti, darabolja, embeddeli és upsertálja őket.
3. `npm run dev`, majd:

```bash
curl -N -X POST http://localhost:3001/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"Mennyi a kommunális adó?"}'
```

A válasz **SSE** stream: `token` események a szövegre, a végén egy `sources`
esemény a forrásokkal, majd `done`.

## Források (adapterek, varrat #1)

- **`manual-upload`** — helyi mappából (`data/uploads/`) olvas PDF/TXT fájlokat.
  Fájlonként opcionális `<fájlnév>.meta.json` (`title`, `category`, `sourceUrl`,
  `publishedAt`) felülírhatja a metaadatot. A leggyorsabb úton tesztelhető vele a
  teljes pipeline. Indítás: `npm run seed`.
- **`wordpress-accordion`** — a `vacratot.hu/dokumentumok` (Document Library Pro)
  PDF-jeit a WordPress REST `wp/v2/media` végpontról listázza, lapozással
  (a tábla JS-rendered, ezért nem statikus scrape). **Korlát:** a REST nem adja a
  plugin kategória-taxonómiáját, így a kategóriát a címből próbáljuk kitalálni,
  különben a `defaultCategory`. Az `npm run reindex` ezt a forrást is feldolgozza
  (a teljes médiatárat — sok PDF, lehet közte szkennelt is, amihez OCR kell).

> **Figyelem:** a `reindex` a teljes `vacratot.hu` médiatárat (több száz PDF)
> letölti és embeddeli — ez időigényes és OpenAI-költséggel jár. Fejlesztéshez a
> `seed` (manual-upload) a gyors, olcsó út.

**Szkennelt PDF-ek (OCR):** ahol nincs kinyerhető szövegréteg (szkennelt kép),
a pipeline a **Tesseract (magyar) OCR-t** futtatja (`tesseract.js` + PDF→PNG
render `@napi-rs/canvas`-szal — nincs rendszerszintű függőség). A cél a
**kereshetőség és idézhetőség**, nem a tökéletes átirat: aláírt/pecsétes/ferde
szkenneknél a szöveg zajos lehet. Kapcsolók: `OCR_ENABLED`, `OCR_MAX_PAGES`,
`OCR_VIEWPORT_SCALE` (lásd `.env.example`).

Ha az OCR is üres eredményt ad (vagy `OCR_ENABLED=false`), a dokumentum
`status='needs_ocr'` jelölést kap chunk nélkül — kereshetetlen marad, de
nyomon követhető és bármikor re-indexelhető (a nem-`active` dokumentumokat a
betöltés mindig újrafeldolgozza). Listázás:
`SELECT external_id, title FROM documents WHERE status = 'needs_ocr';`

**Kategorizálás:** a dokumentum kategóriáját a betöltés a **tartalomból**
(kinyert/OCR-ezett szöveg) állapítja meg, nem a fájlnévből — a `TenantConfig`
`categoryKeywords` (kategória-kulcsonkénti, sorrend = prioritás) kulcsszavai
alapján, a kategória-címkékből képzett tartalékkal. A már betöltött dokumentumok
újrakategorizálása (re-fetch/embed nélkül): `npm run recategorize`.

## Frontend (Angular 21 chat UI)

Minimális, beágyazható chat-felület (BRIEF 7. pont): üdvözlő üzenet, streamelt
válasz, kattintható források, jogi disclaimer. A brandinget a backend
`GET /api/config` végpontjáról tölti (varrat #2 tisztán marad).

```bash
# 1) A backendnek futnia kell (másik terminálban: npm run dev)
# 2) Angular dev szerver — a /api hívásokat a backendre proxyzza (localhost:3001)
npm run dev:frontend
```

A dev szerver a `http://localhost:4200` címen érhető el. A `/api/*` kéréseket a
[frontend/proxy.conf.json](frontend/proxy.conf.json) irányítja a backendre, így
nincs CORS-gond fejlesztés közben.

**Build:** `npm run build -w frontend` → statikus fájlok a `frontend/dist/`-ben.

### Beágyazás iframe-be (auto-magasság)

Az app a tartalom magasságát `postMessage`-dzsel jelzi a szülő oldalnak (nincs
belső görgetés). A beágyazó WordPress-aloldalon:

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

> A `TenantConfig.embed.allowedOrigins` (CORS + CSP `frame-ancestors`) szabályozza,
> mely oldalak ágyazhatják be.

## Hasznos parancsok

| Parancs                             | Mit csinál                              |
| ----------------------------------- | --------------------------------------- |
| `npm run db:up` / `npm run db:down` | Lokális Postgres indítása/leállítása    |
| `npm run migrate`                   | DB séma létrehozása/frissítése          |
| `npm run seed`                      | Betöltés a `manual-upload` adapterrel   |
| `npm run reindex`                   | Az összes konfigurált forrás betöltése  |
| `npm run recategorize`              | Meglévő dokumentumok újrakategorizálása |
| `npm run dev`                       | Backend dev szerver                     |
| `npm run dev:frontend`              | Angular dev szerver (proxyval)          |
| `npm run build -w frontend`         | Frontend production build               |
| `npm run lint` / `npm run format`   | Lint / formázás (backend csomagok)      |
| `npm run typecheck`                 | Típusellenőrzés (shared/config/backend) |

## API

| Végpont             | Leírás                                             |
| ------------------- | -------------------------------------------------- |
| `POST /api/ask`     | RAG válasz SSE-streamként (token → sources → done) |
| `GET /api/health`   | Készenléti ellenőrzés                              |
| `GET /api/config`   | Tenant branding + limitek a UI-nak                 |
| `POST /api/reindex` | Védett (Bearer `REINDEX_TOKEN`) kézi betöltés      |
