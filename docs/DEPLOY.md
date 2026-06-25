# Deployment (Hetzner + Docker + Caddy + GitHub Actions)

A single small Linux server (Hetzner CX22, Ubuntu) runs the stack with Docker
Compose. Push to `main` → GitHub Actions builds the backend image (with the
Angular UI baked in), pushes it to GHCR, and SSHes in to pull + restart.

## Containers (`docker-compose.prod.yml`)

- **caddy** — entry point; automatic HTTPS (Let's Encrypt) and reverse proxy to the backend.
- **backend** — the Node app (also serves the built Angular UI on the same origin), port `3000`.
- **db** — Postgres + pgvector; data persists in the `db_data` volume.

`Caddyfile` maps `ugyseged.vacratotikozosseg.hu` → `backend:3000`.

## Image (`backend/Dockerfile`)

Multi-stage: stage 1 installs the workspace deps and runs `npm run build -w frontend`;
stage 2 is a slim runtime that runs the backend with `tsx` and serves
`frontend/dist/frontend/browser`. Build context is the repo root.

## Secrets

Live only in `./.env` **on the server** (never committed). Copy the template:

```bash
cp .env.prod.example .env   # then fill in OPENAI_API_KEY + a strong POSTGRES_PASSWORD
```

`DATABASE_URL` points at the `db` service host; its password must match `POSTGRES_PASSWORD`.

## First deploy (manual)

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml run --rm backend npm run migrate   # apply the DB schema
docker compose -f docker-compose.prod.yml logs -f                            # troubleshoot
```

Open `https://ugyseged.vacratotikozosseg.hu` — Caddy obtains the certificate on first request.
(Requires DNS already pointing at the server.)

## CI/CD (`.github/workflows/deploy.yml`)

On push to `main`: build + push to GHCR, then SSH pull + `up -d`. Required repo
secrets: `SSH_HOST`, `SSH_USER`, `SSH_KEY` (a dedicated deploy key), `GHCR_PAT`
(`read:packages`, used by the server to pull the image).

> ⚠️ The deploy script is intentionally only `pull` + `up -d` — never `down -v`
> or rebuilding `db`, which would delete the `db_data` volume (all indexed documents).

## Embedding the chat widget

The backend serves a self-contained loader at `/widget.js`. Add this one line to
the host site (e.g. a WordPress header/footer script plugin, site-wide):

```html
<script src="https://ugyseged.vacratotikozosseg.hu/widget.js" defer></script>
```

It renders a floating launcher (bottom-right) that opens a panel with the chat in
an iframe — created lazily on first open, so it never slows the host page's load.
The host origin must be listed in `TenantConfig.embed.allowedOrigins` (it drives
both CORS and the CSP `frame-ancestors` that allows the iframe). The app detects
`?embed=widget` and switches to the compact panel layout.

## Operations

- **Logs:** `docker compose -f docker-compose.prod.yml logs -f backend`
- **Scheduled ingestion:** a server cron running `docker compose -f docker-compose.prod.yml run --rm backend npm run reindex`
- **Backups:** daily `pg_dump` and/or Hetzner backups.
