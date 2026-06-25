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
    /** User-facing name of the assistant — used for the app header, the widget
     *  launcher label, and the widget panel title (distinct from displayName,
     *  which is the organisation's formal name). */
    assistantName: string;
    logoUrl?: string;
    primaryColor?: string;
    /** Foreground (text/icon) colour shown on top of primaryColor — set this for
     *  readable contrast when primaryColor is light. Defaults to white. */
    onPrimaryColor?: string;
    /** Short glyph/emoji on the widget launcher button (e.g. "§"). Defaults to "§". */
    launcherIcon?: string;
    /** Welcome message at the top of the chat. */
    welcomeMessage: string;
    /** Legal disclaimer (always visible / on every answer). */
    disclaimer: string;
    /** Developer/copyright attribution line shown under the disclaimer.
     *  Product-wide (same developer for every tenant); set in default.ts. */
    attribution?: string;
    /** Contact email rendered as a mailto link next to the attribution. */
    contactEmail?: string;
    /** Small release-stage badge next to the version (e.g. "BETA"). Omit at 1.0. */
    versionBadge?: string;
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
