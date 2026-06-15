> **English** · [Magyar](README.hu.md)

# Frontend — Municipal Assistant (Angular 21)

Embeddable chat interface for `municipal-assistant`: streamed responses (SSE),
clickable sources, legal disclaimer, iframe auto-height. It loads branding and
limits from the backend `GET /api/config` endpoint.

For the project as a whole (setup, backend, data loading): see the root
[README.md](../README.md).

## Development

The backend must be running (`npm run dev` from the root, `localhost:3001`). Then:

```bash
npm run dev:frontend     # from the root — Angular dev server + /api proxy
# or from the frontend folder:
npm start                # ng serve --proxy-config proxy.conf.json
```

The dev server: `http://localhost:4200`. The `/api/*` requests are proxied to the
backend by [proxy.conf.json](proxy.conf.json) (no CORS issues).

## Build

```bash
npm run build -w frontend   # static output: frontend/dist/
```

## Embedding

The app reports the content height to the parent page via `postMessage`
(`municipal-assistant:resize`) — see the "Embedding in an iframe" section of the root README.
The embedding origins are controlled by `TenantConfig.embed.allowedOrigins` (CORS + CSP).
