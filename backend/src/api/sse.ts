import type { Response } from 'express';
import type { AskEvent } from '@municipal-assistant/shared';

/** Sets the SSE headers and flushes them immediately. */
export function initSse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

/** Sends a single typed AskEvent to the stream. */
export function sendEvent(res: Response, event: AskEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
