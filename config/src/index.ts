import type { TenantConfig } from '@municipal-assistant/shared';
import { deepMerge, type DeepPartial } from './deep-merge.js';
import { defaultConfig } from './default.js';
import { tenantConfigSchema } from './schema.js';
import { vacratot } from './tenants/vacratot.js';

export { defaultConfig } from './default.js';
export { tenantConfigSchema } from './schema.js';

/**
 * Statikus tenant-regiszter. Új település indítása: ide egy új bejegyzés
 * (és — ha kell — egy új adapter a backend registry-ben). Nincs admin-felület
 * a bérlőkezeléshez (BRIEF 9. pont).
 */
const tenants: Record<string, DeepPartial<TenantConfig>> = {
  vacratot,
};

/**
 * Betölti és validálja egy tenant configját: default <- tenant mély merge,
 * majd zod-validáció. Hibás config esetén beszédes hibát dob.
 */
export function loadTenantConfig(tenantId: string): TenantConfig {
  const overrides = tenants[tenantId];
  if (!overrides) {
    const known = Object.keys(tenants).join(', ') || '(nincs)';
    throw new Error(`Ismeretlen tenant: "${tenantId}". Ismert tenantok: ${known}`);
  }

  const merged = deepMerge(defaultConfig as TenantConfig, overrides);
  const result = tenantConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Érvénytelen tenant config (${tenantId}):\n${issues}`);
  }
  return result.data as TenantConfig;
}

/** Az ismert tenant-azonosítók. */
export function listTenantIds(): string[] {
  return Object.keys(tenants);
}
