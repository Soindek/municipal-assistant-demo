// ─────────────────────── shared/src/tenant-config.ts ──────────────────────
// VARRAT #2 típusai. Titkok (API-kulcsok) NEM ide jönnek, hanem env-ből.

/** Egy forrás-leíró a configban: melyik adapter, milyen paraméterrel. */
export interface SourceDescriptor {
  /** A registry-ben regisztrált adapter neve (pl. "wordpress-accordion"). */
  adapter: string;
  /** Adapter-specifikus paraméterek (pl. { baseUrl, categoryMap }). */
  options: Record<string, unknown>;
}

/**
 * VARRAT #2 — minden településspecifikus beállítás egy helyen.
 * Titkok (API-kulcsok) NEM ide jönnek, hanem env-ből.
 */
export interface TenantConfig {
  /** Gépi azonosító, pl. "vacratot". */
  tenantId: string;
  /** Megjelenítendő név, pl. "Vácrátót Község Önkormányzata". */
  displayName: string;
  /** BCP-47 locale, pl. "hu-HU". */
  locale: string;

  branding: {
    logoUrl?: string;
    primaryColor?: string;
    /** Üdvözlő üzenet a chat tetején. */
    welcomeMessage: string;
    /** Jogi figyelmeztetés (mindig látszik / minden válasznál). */
    disclaimer: string;
  };

  embed: {
    /** CORS + CSP frame-ancestors, pl. ["https://vacratotikozosseg.hu"]. */
    allowedOrigins: string[];
  };

  /** Taxonómia: kulcs → emberi címke. A SourceDocument.category ezekre hivatkozik. */
  categories: Record<string, string>;

  /** Milyen forrásokból töltünk. */
  sources: SourceDescriptor[];

  rag: {
    topK: number;
    /** Küszöb: ez alatt "nem tudom" válasz (hallucináció ellen). */
    minScore: number;
    embeddingModel: string;
    chatModel: string;
    /**
     * Rendszerprompt-sablon. Behelyettesítendő tokenek pl. {displayName}.
     * Tartalmazza a kontextuson-kívüli-válasz tiltását és az idézési szabályt.
     */
    systemPromptTemplate: string;
  };

  limits: {
    maxQuestionChars: number;
    requestsPerMinutePerIp: number;
  };
}
