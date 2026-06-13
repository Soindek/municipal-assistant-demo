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
    welcomeMessage:
      'Üdvözlöm! Vácrátót hivatalos dokumentumai alapján segítek. Miben lehetek a segítségére?',
    disclaimer:
      'Ez tájékoztatás, nem hivatalos jogi tanács. Kérjük, ellenőrizze a megjelölt forrásban.',
  },

  embed: {
    allowedOrigins: ['https://vacratotikozosseg.hu'],
  },

  categories: {
    rendeletek: 'Rendeletek',
    jegyzokonyvek: 'Jegyzőkönyvek',
    polgarmesteri_hatarozatok: 'Polgármesteri határozatok',
    hvb_hatarozatok: 'HVB határozatok',
    nyomtatvanyok: 'Nyomtatványok',
    szerzodesek: 'Szerződések',
    telepulesrendezes: 'Településrendezési és szabályozási tervek',
    hirmondo: 'Vácrátóti Hírmondó',
  },

  // Content keywords for categorizing a document from its (OCR'd) text.
  // Order = priority (first match wins). Strong document-TYPE signals come
  // first; generic topic words (kérelem, bejelentés) are avoided as they
  // appear across many document types and would mis-grab real rendeletek.
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
    // The vacratot.hu/dokumentumok source via the WordPress REST media endpoint
    // (the Document Library Pro table is JS-rendered; see wordpress-accordion adapter).
    {
      adapter: 'wordpress-accordion',
      options: {
        baseUrl: 'https://vacratot.hu/dokumentumok/',
        // We try to infer the category from the document title using these keywords;
        // otherwise defaultCategory (the REST media does not provide the DLP category).
        categoryMap: {
          Rendeletek: 'rendeletek',
          Jegyzőkönyvek: 'jegyzokonyvek',
          'Polgármesteri határozatok': 'polgarmesteri_hatarozatok',
          'HVB határozatok': 'hvb_hatarozatok',
          Nyomtatványok: 'nyomtatvanyok',
          Szerződések: 'szerzodesek',
          'Településrendezési és szabályozási tervek': 'telepulesrendezes',
          'Vácrátóti Hírmondó': 'hirmondo',
        },
        defaultCategory: 'rendeletek',
      },
    },
    // Authoritative, in-force decrees from the Nemzeti Jogszabálytár (njt.jog.gov.hu).
    // listFilter encodes the settlement (473 = Vácrátót, 2 = Pest) AND the
    // "csak hatályos" (in-force only) view, so revoked decrees are excluded.
    // authoritativeFor: njt overrides vacratot.hu's scanned rendeletek (same category).
    {
      adapter: 'njt-onkormanyzati',
      options: {
        baseUrl: 'https://njt.jog.gov.hu',
        listFilter: '-:-:-:-:1:-:-:1:-:-:2:473:-',
        category: 'rendeletek',
        authoritativeFor: ['rendeletek'],
      },
    },
    // Later: { adapter: 'google-drive', options: { folderId: '...' } }  // Glass pocket (transparency)
  ],

  rag: {
    topK: 6,
    minScore: 0.2,
    // Models (BRIEF point 2 + session decision): cheap models that perform well in Hungarian.
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4.1-mini',
  },

  limits: {
    maxQuestionChars: 1000,
    requestsPerMinutePerIp: 20,
  },
};
