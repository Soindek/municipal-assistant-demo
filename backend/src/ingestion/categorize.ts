/**
 * Content-aware document categorization.
 *
 * The adapter can only guess a category from metadata (often a filename); the
 * extracted/OCR'd TEXT is a far better signal (e.g. "jegyzőkönyv", "önkormányzati
 * rendelete", "Helyi Választási Bizottság"). This refines the category from text.
 *
 * Tenant-agnostic: the matching keywords come from the tenant config —
 * `categoryKeywords` (ordered, domain-specific phrases) take priority, then a
 * stem derived from each category label. First match (in that order) wins;
 * otherwise the fallback is returned.
 */

import type { TenantConfig } from '@municipal-assistant/shared';

export interface CategoryRules {
  /** Valid category keys → human label (TenantConfig.categories). */
  categories: Record<string, string>;
  /** Optional ordered keyword phrases per category key (most specific first). */
  categoryKeywords?: Record<string, string[]>;
  /** Used when nothing matches. */
  fallback: string;
}

/** Strip common Hungarian plural endings from a label to get a keyword stem. */
function stripPlural(label: string): string {
  return label
    .toLowerCase()
    .replace(/(ek|ök|ok|ák|k)$/u, '')
    .trim();
}

interface Rule {
  key: string;
  keyword: string;
}

/**
 * Builds the ordered match list: explicit categoryKeywords first (in config
 * order), then a label stem for every category key. Keywords shorter than 4
 * chars are dropped to avoid noise.
 */
function buildRules(rules: CategoryRules): Rule[] {
  const out: Rule[] = [];
  // Explicit, tenant-provided keywords (trusted): allow short codes like "jkv".
  for (const [key, words] of Object.entries(rules.categoryKeywords ?? {})) {
    for (const w of words) {
      const kw = w.toLowerCase().trim();
      if (kw.length >= 3) out.push({ key, keyword: kw });
    }
  }
  // Label-derived stems (auto): keep a higher bar to avoid noise.
  for (const [key, label] of Object.entries(rules.categories)) {
    const stem = stripPlural(label);
    if (stem.length >= 4) out.push({ key, keyword: stem });
  }
  return out;
}

/**
 * Returns the best category key for a document. `text` should be a sample of the
 * document body (e.g. the first ~2000 chars); `title` is also searched.
 */
export function categorize(title: string, text: string, rules: CategoryRules): string {
  const haystack = `${title}\n${text}`.toLowerCase();
  for (const { key, keyword } of buildRules(rules)) {
    if (haystack.includes(keyword)) return key;
  }
  return rules.fallback;
}

/**
 * Builds a categorizer hook bound to a tenant config. The hook takes a title,
 * a text sample and a fallback category, and returns the best category key.
 */
export function buildCategorizer(
  config: TenantConfig,
): (title: string, text: string, fallback: string) => string {
  return (title, text, fallback) =>
    categorize(title, text, {
      categories: config.categories,
      categoryKeywords: config.categoryKeywords,
      fallback,
    });
}
