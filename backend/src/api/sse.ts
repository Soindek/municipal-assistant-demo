import type { Response } from 'express';
import type { AskEvent } from '@municipal-assistant/shared';

/** SSE-fejlécek beállítása és azonnali kiírása. */
export function initSse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

/** Egy tipizált AskEvent kiküldése a streamre. */
export function sendEvent(res: Response, event: AskEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
