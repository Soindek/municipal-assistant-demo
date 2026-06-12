import express from 'express';
import type { Express } from 'express';
import type { ApiDeps } from './deps.js';
import { createAskHandler, createHealthHandler, createReindexHandler } from './handlers.js';
import { corsAndCsp, rateLimit } from './middleware.js';

/** Felépíti az Express alkalmazást a már feloldott függőségekből. */
export function createApp(deps: ApiDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));
  app.use(corsAndCsp(deps.config));

  // Health: rate limit nélkül (uptime-check ne ütközzön a limitbe).
  app.get('/api/health', createHealthHandler(deps));

  // Nyilvános, IP-alapú rate limittel védett végpont.
  app.post(
    '/api/ask',
    rateLimit(deps.config.limits.requestsPerMinutePerIp),
    createAskHandler(deps),
  );

  app.post('/api/reindex', createReindexHandler(deps));

  return app;
}
