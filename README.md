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

## Hasznos parancsok

| Parancs | Mit csinál |
| --- | --- |
| `npm run db:up` / `npm run db:down` | Lokális Postgres indítása/leállítása |
| `npm run migrate` | DB séma létrehozása/frissítése |
| `npm run seed` | Betöltés a `manual-upload` adapterrel |
| `npm run reindex` | Az összes konfigurált forrás betöltése |
| `npm run dev` | Backend dev szerver |
| `npm run lint` / `npm run format` | Lint / formázás |
| `npm run typecheck` | Típusellenőrzés minden csomagra |

## Állapot (1. kör)

A scaffold és a backend vertikális szelet épül (BRIEF 10. pont). A frontend és a
finomítások a 2. körben jönnek.
