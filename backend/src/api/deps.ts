import type { TenantConfig } from '@municipal-assistant/shared';
import type { Env } from '../env.js';
import type { LlmClients } from '../llm/types.js';

/** Shared dependencies for the API handlers (built once at server startup). */
export interface ApiDeps {
  config: TenantConfig;
  llm: LlmClients;
  env: Env;
}
