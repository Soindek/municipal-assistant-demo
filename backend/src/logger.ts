import type { SourceLogger } from '@municipal-assistant/shared';

/** Egyszerű konzol-logger; ezt injektáljuk az adaptereknek és a pipeline-nak. */
export const consoleLogger: SourceLogger = {
  info: (msg, meta) => console.log(`[info]  ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[warn]  ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[error] ${msg}`, meta ?? ''),
};
