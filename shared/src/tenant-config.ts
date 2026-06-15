// ─────────────────────── shared/src/tenant-config.ts ──────────────────────
// SEAM #2 types. Secrets (API keys) do NOT belong here — they come from env.

/** A source descriptor in the config: which adapter, with which parameters. */
export interface SourceDescriptor {
  /** The name of the adapter registered in the registry (e.g. "wordpress-accordion"). */
  adapter: string;
  /** Adapter-specific parameters (e.g. { baseUrl, categoryMap }). */
  options: Record<string, unknown>;
}

/**
 * SEAM #2 — all municipality-specific settings in one place.
 * Secrets (API keys) do NOT belong here — they come from env.
 */
export interface TenantConfig {
  /** Machine identifier, e.g. "vacratot". */
  tenantId: string;
  /** Display name, e.g. "Vácrátót Község Önkormányzata". */
  displayName: string;
  /** BCP-47 locale, e.g. "hu-HU". */
  locale: string;

  branding: {
    logoUrl?: string;
    primaryColor?: string;
    /** Welcome message at the top of the chat. */
    welcomeMessage: string;
    /** Legal disclaimer (always visible / on every answer). */
    disclaimer: string;
  };

  embed: {
    /** CORS + CSP frame-ancestors, e.g. ["https://vacratotikozosseg.hu"]. */
    allowedOrigins: string[];
  };

  /** Taxonomy: key → human label. SourceDocument.category references these. */
  categories: Record<string, string>;

  /**
   * Optional content keywords per category key, used to categorize a document
   * from its extracted/OCR text (more reliable than a filename). Ordered: the
   * first matching keyword wins, so list more specific categories first.
   */
  categoryKeywords?: Record<string, string[]>;

  /** Which sources we ingest from. */
  sources: SourceDescriptor[];

  rag: {
    topK: number;
    /** Threshold: below this, answer "I don't know" (guards against hallucination). */
    minScore: number;
    embeddingModel: string;
    chatModel: string;
    /**
     * Categories whose documents are authoritative/current (e.g. in-force
     * decrees, info pages). A focused per-category search guarantees their best
     * matches reach the rerank window, so a concise authoritative document isn't
     * crowded out of the global pool. Empty/undefined disables the guarantee.
     */
    authoritativeCategories?: string[];
    /**
     * Optional per-category ranking multiplier (category key → weight, default
     * 1.0). Nudges authoritative/current sources up and archival/time-bound ones
     * down in the candidate pool ordering.
     */
    categoryWeights?: Record<string, number>;
    /**
     * System prompt template. Tokens to substitute, e.g. {displayName}.
     * Includes the out-of-context answer ban and the citation rule.
     */
    systemPromptTemplate: string;
  };

  limits: {
    maxQuestionChars: number;
    requestsPerMinutePerIp: number;
  };
}
