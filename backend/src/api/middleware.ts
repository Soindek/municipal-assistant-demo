import type { RequestHandler } from 'express';
import type { TenantConfig } from '@municipal-assistant/shared';

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * CORS + CSP frame-ancestors based on TenantConfig.embed.allowedOrigins
 * (BRIEF point 8). localhost is also allowed for local development.
 */
export function corsAndCsp(config: TenantConfig): RequestHandler {
  const allowed = new Set(config.embed.allowedOrigins);
  // In development also let localhost embed (frame) the app, so the widget can be
  // tried locally; production (NODE_ENV=production) stays locked to the configured
  // origins only.
  const devAncestors =
    process.env.NODE_ENV === 'production'
      ? []
      : ['http://localhost:*', 'http://127.0.0.1:*'];
  const ancestors = [...config.embed.allowedOrigins, ...devAncestors];
  const frameAncestors = ancestors.length ? ancestors.join(' ') : "'none'";

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowed.has(origin) || LOCALHOST_RE.test(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    // Only allowed origins may embed it in an iframe.
    res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * Simple, IP-based fixed-window rate limit (BRIEF point 8).
 * Note: per-process, in-memory — a shared store is needed for multiple instances.
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
      res.status(429).json({ error: 'Too many requests. Please try again a little later.' });
      return;
    }
    entry.count++;
    next();
  };
}
