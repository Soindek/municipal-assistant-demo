import express from 'express';
import type { Express } from 'express';
import type { ApiDeps } from './deps.js';
import {
  createAskHandler,
  createConfigHandler,
  createHealthHandler,
  createReindexHandler,
} from './handlers.js';
import { corsAndCsp, rateLimit } from './middleware.js';

/** Builds the Express application from the already-resolved dependencies. */
export function createApp(deps: ApiDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));
  app.use(corsAndCsp(deps.config));

  // Health: no rate limit (so uptime checks don't hit the limit).
  app.get('/api/health', createHealthHandler(deps));

  // Public tenant branding for the UI.
  app.get('/api/config', createConfigHandler(deps));

  // Public endpoint protected by an IP-based rate limit.
  app.post(
    '/api/ask',
    rateLimit(deps.config.limits.requestsPerMinutePerIp),
    createAskHandler(deps),
  );

  app.post('/api/reindex', createReindexHandler(deps));

  return app;
}
