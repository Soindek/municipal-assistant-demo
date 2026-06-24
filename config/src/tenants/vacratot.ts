import type { TenantConfig } from '@municipal-assistant/shared';
import type { DeepPartial } from '../deep-merge.js';

/**
 * SEAM #2 — Vácrátót (MVP tenant). Only specifies the differences; the rest is
 * filled in by default.ts. A secret (API key) NEVER goes here — it comes from env.
 */
export const vacratot: DeepPartial<TenantConfig> = {
  tenantId: 'vacratot',
  displayName: 'Vácrátót Község Önkormányzata',
  locale: 'hu-HU',

  branding: {
    assistantName: 'Vácrátóti Ügysegéd',
    primaryColor: 'rgb(126, 217, 87)',
    welcomeMessage:
      'Üdvözlöm! Vácrátót hivatalos dokumentumai (rendeletek, jegyzőkönyvek, szerződések) alapján segítek. Miben lehetek a segítségére?',
    disclaimer:
      'Ez tájékoztatás, nem hivatalos jogi tanács. Kérjük, ellenőrizze a megjelölt forrásban.',
  },

  embed: {
    // The host site (apex + www) where the floating widget is embedded. Drives
    // both CORS and the CSP frame-ancestors that lets the iframe load there.
    allowedOrigins: ['https://vacratotikozosseg.hu', 'https://www.vacratotikozosseg.hu'],
  },

  // Taxonomy mirrors the curated Document Library Pro folders on vacratot.hu.
  categories: {
    rendeletek: 'Rendeletek',
    jegyzokonyvek: 'Jegyzőkönyvek',
    polgarmesteri_hatarozatok: 'Polgármesteri határozatok',
    hvb_hatarozatok: 'HVB határozatok',
    nyomtatvanyok: 'Nyomtatványok',
    szerzodesek: 'Szerződések',
    telepulesrendezes: 'Településrendezési és szabályozási tervek',
    hirmondo: 'Vácrátóti Hírmondó',
    bejelentes_koteles: 'Bejelentés-köteles kereskedelmi tevékenységek',
    egyeb: 'Egyéb dokumentumok',
    uvegzseb: 'Üvegzseb, szerződések',
    oldalak: 'Önkormányzati oldalak',
  },

  // Content keywords for categorizing a document from its (OCR'd) text.
  // Order = priority (first match wins). Strong document-TYPE signals come
  // first; generic topic words (kérelem, bejelentés) are avoided as they
  // appear across many document types and would mis-grab real decrees.
  categoryKeywords: {
    jegyzokonyvek: ['jegyzőkönyv', 'jkv', 'képviselő-testület ülés'],
    hvb_hatarozatok: ['választási bizottság', 'helyi választási'],
    telepulesrendezes: [
      'szabályozási terv',
      'helyi építési szabályzat',
      'hész',
      'településrendezési',
      'változtatási tilalom',
    ],
    polgarmesteri_hatarozatok: ['polgármesteri határozat', 'polgármester határozat'],
    szerzodesek: [
      'vállalkozási szerződés',
      'megbízási szerződés',
      'adásvételi',
      'bérleti szerződés',
    ],
    rendeletek: ['önkormányzati rendelet', 'rendelete', 'rendelet módosítás'],
    nyomtatvanyok: ['nyomtatvány', 'űrlap', 'adatlap', 'bejelentésköteles'],
    hirmondo: ['hírmondó'],
  },

  sources: [
    // Round 1: get the full pipeline working with the manual-upload adapter.
    // Put the test PDFs under data/uploads/ (or the directory specified here).
    {
      adapter: 'manual-upload',
      options: {
        dir: './data/uploads',
        // Default category for files in the directory (can be overridden
        // with a <filename>.meta.json — see manual-upload adapter).
        defaultCategory: 'rendeletek',
      },
    },
    // The CURATED Document Library Pro list on vacratot.hu/dokumentumok (the
    // canonical source). Replaces the old wp/v2/media adapter: real DLP folders
    // = real categories, external links included, no media-library noise.
    // trustCategory: the folder IS the category, so don't re-categorize from text.
    {
      adapter: 'dlp-library',
      options: {
        baseUrl: 'https://vacratot.hu',
        documentsPath: '/dokumentumok/',
        trustCategory: true,
        // DLP folder name → category key.
        categoryMap: {
          Rendeletek: 'rendeletek',
          Jegyzőkönyvek: 'jegyzokonyvek',
          'Polgármesteri határozatok': 'polgarmesteri_hatarozatok',
          'HVB határozatok': 'hvb_hatarozatok',
          Nyomtatványok: 'nyomtatvanyok',
          Szerződések: 'szerzodesek',
          'Településrendezési és szabályozási tervek': 'telepulesrendezes',
          'Vácrátóti Hírmondó': 'hirmondo',
          'Bejelentés-köteles kereskedelmi tevékenységek': 'bejelentes_koteles',
          'Egyéb dokumentumok': 'egyeb',
          'Üvegzseb, szerződések': 'uvegzseb',
        },
        defaultCategory: 'egyeb',
        // Decrees come authoritatively from njt-decrees (which supersedes these),
        // so skip the DLP "Rendeletek" folder and don't waste OCR on it.
        excludeCategories: ['Rendeletek'],
      },
    },
    // Authoritative, in-force decrees from the Nemzeti Jogszabálytár (njt.jog.gov.hu).
    // listFilter encodes the settlement (473 = Vácrátót, 2 = Pest) AND the
    // in-force-only view, so revoked decrees are excluded.
    // authoritativeFor: njt overrides vacratot.hu's scanned decrees (same 'rendeletek' category).
    {
      adapter: 'njt-decrees',
      options: {
        baseUrl: 'https://njt.jog.gov.hu',
        listFilter: '-:-:-:-:1:-:-:1:-:-:2:473:-',
        category: 'rendeletek',
        authoritativeFor: ['rendeletek'],
        // Everything from njt IS a decree, so keep the 'rendeletek' category.
        // Without this the content categorizer moves planning-related decrees
        // (HÉSZ, szabályozási terv, változtatási tilalom) to 'telepulesrendezes'.
        trustCategory: true,
        // Include the decrees' reasoning ("indokolás") documents — citizens
        // often ask about the rationale, not just the rule itself.
        includeReasoning: true,
        // njt rate-limits aggressively (HTTP 500 under bursts); be gentle.
        // Failed docs aren't upserted, so simply re-running reindex retries
        // only the missing ones (the done ones are skipped) until it converges.
        requestDelayMs: 3000,
      },
    },
    // The "Üvegzseb" (glass pocket / transparency) portal on a public Google
    // Drive folder. No API key needed — the public embeddedfolderview is scraped
    // and files are downloaded via uc?export=download. The tree is traversed
    // recursively. trustCategory: keep everything under 'uvegzseb' (the folder
    // overlaps with DLP content — Hírmondó, Szerződések — so a separate category
    // avoids muddling those; dedup can come later if needed).
    {
      adapter: 'google-drive',
      options: {
        folderId: '0B5p6_K4iMP2XeXZHcFVpY29FOTg',
        resourceKey: '0--UYONBlz-qBSbijklhERoA',
        category: 'uvegzseb',
        trustCategory: true,
      },
    },
    // Static WordPress PAGES (office info, services) via the REST API — NOT
    // posts (those are time-bound news). Cleaned to plain text; trivial pages
    // (empty / document-list embeds) are filtered out. Category 'oldalak' keeps
    // the source type visible and preserves the priority of authoritative
    // sources (rendeletek, njt). trustCategory: always 'oldalak'.
    {
      adapter: 'wordpress-pages',
      options: {
        baseUrl: 'https://vacratot.hu',
        category: 'oldalak',
        trustCategory: true,
      },
    },
  ],

  rag: {
    topK: 8,
    minScore: 0.2,
    // In-force decrees and current info pages are the authoritative answers; a
    // focused per-category search guarantees their best matches reach the rerank
    // window (the archival corpus would otherwise crowd them out).
    authoritativeCategories: ['rendeletek', 'oldalak'],
    // Ranking nudge in the general pool: lift current/authoritative sources,
    // damp the large archival corpus.
    categoryWeights: {
      oldalak: 1.6,
      rendeletek: 1.5,
      nyomtatvanyok: 1.2,
      hirmondo: 0.75,
      jegyzokonyvek: 0.85,
      uvegzseb: 0.85,
    },
    // Models (BRIEF point 2 + session decision): cheap models that perform well in Hungarian.
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4.1-mini',
  },

  limits: {
    maxQuestionChars: 1000,
    requestsPerMinutePerIp: 20,
  },
};
