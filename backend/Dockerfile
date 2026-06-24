# syntax=docker/dockerfile:1
# Build context is the repo ROOT (monorepo). Multi-stage:
#  1) install all workspace deps + build the Angular frontend,
#  2) a runtime image that runs the backend with tsx and serves the built UI.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Install with the full workspace manifest set so npm sets up the workspaces.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY config/package.json ./config/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci
COPY . .
# Angular production build → frontend/dist/frontend/browser
RUN npm run build -w frontend

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Reuse the installed dependencies (includes tsx, which runs the TS backend +
# the TS-source workspace packages) and the source; bring the built UI in.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/shared ./shared
COPY --from=build /app/config ./config
COPY --from=build /app/backend ./backend
COPY --from=build /app/frontend/package.json ./frontend/package.json
COPY --from=build /app/frontend/dist ./frontend/dist
EXPOSE 3000
# `start` = tsx src/server.ts; the server reads PORT/secrets from the env.
CMD ["npm", "run", "start", "-w", "@municipal-assistant/backend"]
