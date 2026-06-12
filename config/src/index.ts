import type { TenantConfig } from '@municipal-assistant/shared';
import { deepMerge, type DeepPartial } from './deep-merge.js';
import { defaultConfig } from './default.js';
import { tenantConfigSchema } from './schema.js';
import { vacratot } from './tenants/vacratot.js';

export { defaultConfig } from './default.js';
export { tenantConfigSchema } from './schema.js';

/**
 * Static tenant registry. Onboarding a new municipality: add a new entry here
 * (and — if needed — a new adapter in the backend registry). There is no admin
 * UI for tenant management (BRIEF point 9).
 */
const tenants: Record<string, DeepPartial<TenantConfig>> = {
  vacratot,
};

/**
 * Loads and validates a tenant's config: default <- tenant deep merge, then
 * zod validation. Throws a descriptive error for an invalid config.
 */
export function loadTenantConfig(tenantId: string): TenantConfig {
  const overrides = tenants[tenantId];
  if (!overrides) {
    const known = Object.keys(tenants).join(', ') || '(none)';
    throw new Error(`Unknown tenant: "${tenantId}". Known tenants: ${known}`);
  }

  const merged = deepMerge(defaultConfig as TenantConfig, overrides);
  const result = tenantConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid tenant config (${tenantId}):\n${issues}`);
  }
  return result.data as TenantConfig;
}

/** The known tenant identifiers. */
export function listTenantIds(): string[] {
  return Object.keys(tenants);
}
