import type { TenantConfig } from '@municipal-assistant/shared';
import type { Env } from '../env.js';
import type { LlmClients } from '../llm/types.js';

/** Az API handlerek közös függőségei (egyszer felépítve a szerver indulásakor). */
export interface ApiDeps {
  config: TenantConfig;
  llm: LlmClients;
  env: Env;
}
