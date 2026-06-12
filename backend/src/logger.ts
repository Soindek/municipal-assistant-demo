import type { SourceLogger } from '@municipal-assistant/shared';

/** Simple console logger; injected into the adapters and the pipeline. */
export const consoleLogger: SourceLogger = {
  info: (msg, meta) => console.log(`[info]  ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[warn]  ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[error] ${msg}`, meta ?? ''),
};
