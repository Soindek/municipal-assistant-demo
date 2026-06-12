import type { TenantConfig } from '@municipal-assistant/shared';
import type { DeepPartial } from '../deep-merge.js';

/**
 * VARRAT #2 — Vácrátót (MVP bérlő). Csak az eltéréseket adja meg; a többit a
 * default.ts tölti ki. Titok (API-kulcs) ide SOHA nem kerül — az env-ből jön.
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

  sources: [
    // 1. kör: a teljes pipeline-t a manual-upload adapterrel hozzuk működésre.
    // Tedd a teszt-PDF-eket a data/uploads/ alá (vagy az itt megadott mappába).
    {
      adapter: 'manual-upload',
      options: {
        dir: './data/uploads',
        // A mappában lévő fájlok alapértelmezett kategóriája (felülírható
        // egy <fájlnév>.meta.json-nal — lásd manual-upload adapter).
        defaultCategory: 'rendeletek',
      },
    },
    // A vacratot.hu/dokumentumok forrás a WordPress REST media végponton át
    // (a Document Library Pro tábla JS-rendered; lásd wordpress-accordion adapter).
    {
      adapter: 'wordpress-accordion',
      options: {
        baseUrl: 'https://vacratot.hu/dokumentumok/',
        // A kategóriát a dokumentum címéből próbáljuk kitalálni e kulcsszavakkal;
        // egyébként defaultCategory (a REST media nem adja a DLP-kategóriát).
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
    // Később: { adapter: 'google-drive', options: { folderId: '...' } }  // Üvegzseb
  ],

  rag: {
    topK: 6,
    minScore: 0.2,
    // Modellek (BRIEF 2. pont + session-döntés): olcsó, magyarul jó modellek.
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4.1-mini',
  },

  limits: {
    maxQuestionChars: 1000,
    requestsPerMinutePerIp: 20,
  },
};
