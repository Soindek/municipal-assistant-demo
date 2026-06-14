# Frontend — Önkormányzati Ügysegéd (Angular 21)

Beágyazható chat-felület a `municipal-assistant`-hoz: streamelt válasz (SSE),
kattintható források, jogi disclaimer, iframe-auto-magasság. A brandinget és a
limiteket a backend `GET /api/config` végpontjáról tölti.

A projekt egészéről (beüzemelés, backend, adatbetöltés): a gyökér
[README.md](../README.md).

## Fejlesztés

A backendnek futnia kell (`npm run dev` a gyökérből, `localhost:3001`). Majd:

```bash
npm run dev:frontend     # a gyökérből — Angular dev szerver + /api proxy
# vagy a frontend mappából:
npm start                # ng serve --proxy-config proxy.conf.json
```

A dev szerver: `http://localhost:4200`. A `/api/*` kéréseket a
[proxy.conf.json](proxy.conf.json) a backendre proxyzza (nincs CORS-gond).

## Build

```bash
npm run build -w frontend   # statikus kimenet: frontend/dist/
```

## Beágyazás

Az app a tartalom magasságát `postMessage`-dzsel jelzi a szülő oldalnak
(`municipal-assistant:resize`) — lásd a gyökér README „Beágyazás iframe-be" részét.
A beágyazó originokat a `TenantConfig.embed.allowedOrigins` (CORS + CSP) szabályozza.
