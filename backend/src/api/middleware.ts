import type { RequestHandler } from 'express';
import type { TenantConfig } from '@municipal-assistant/shared';

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * CORS + CSP frame-ancestors a TenantConfig.embed.allowedOrigins alapján
 * (BRIEF 8. pont). Lokális fejlesztéshez a localhost is engedélyezett.
 */
export function corsAndCsp(config: TenantConfig): RequestHandler {
  const allowed = new Set(config.embed.allowedOrigins);
  const frameAncestors = config.embed.allowedOrigins.length
    ? config.embed.allowedOrigins.join(' ')
    : "'none'";

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowed.has(origin) || LOCALHOST_RE.test(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    // Csak az engedélyezett originek ágyazhatják be iframe-be.
    res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * Egyszerű, IP-alapú fixed-window rate limit (BRIEF 8. pont).
 * Megjegyzés: per-process, memóriában — több instance esetén közös store kell.
 */
export function rateLimit(requestsPerMinute: number): RequestHandler {
  const windowMs = 60_000;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req, res, next) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(ip);

    if (!entry || now > entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (entry.count >= requestsPerMinute) {
      res.status(429).json({ error: 'Túl sok kérés. Kérjük, próbálja kicsit később.' });
      return;
    }
    entry.count++;
    next();
  };
}
