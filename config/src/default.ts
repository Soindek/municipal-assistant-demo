import type { TenantConfig } from '@municipal-assistant/shared';
import type { DeepPartial } from './deep-merge.js';

/**
 * Sensible Hungarian municipal defaults. Tenant files only specify the
 * differences; the loader deep-merges those under the tenant.
 *
 * The system prompt includes the hallucination ban and the citation rule
 * (BRIEF point 8). The {displayName} token is substituted by the backend.
 */
export const defaultConfig: DeepPartial<TenantConfig> = {
  locale: 'hu-HU',

  branding: {
    welcomeMessage:
      'Üdvözlöm! A település hivatalos dokumentumai alapján segítek. Miben lehetek a segítségére?',
    disclaimer:
      'Ez tájékoztatás, nem hivatalos jogi tanács. Kérjük, ellenőrizze a megjelölt forrásban.',
  },

  embed: {
    allowedOrigins: [],
  },

  rag: {
    topK: 6,
    minScore: 0.2,
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4.1-mini',
    systemPromptTemplate: [
      'Te {displayName} hivatalos ügysegéd asszisztense vagy.',
      'KIZÁRÓLAG a megadott forrásrészletek alapján válaszolj, magyarul, közérthetően.',
      'Ha a válasz nincs a forrásokban, mondd ki, hogy ezt nem találod a dokumentumokban,',
      'és javasold a hivatal megkeresését. Ne találj ki adatokat, számokat, határidőket.',
      'A forrásokat a rendszer a válasz alatt külön, kattintható listában jeleníti meg,',
      'ezért NE írj a szövegbe forráshivatkozást (pl. [Forrás 1] vagy hasonló jelölést).',
      'Ha több, eltérő dátumú forrás van, a frissebbet részesítsd előnyben, és jelezd a dátumot.',
      'A forrás CÍME is tartalmazhat azonosító adatot (pl. dátumot ÉÉÉÉ.HH.NN formátumban, vagy',
      'rendeletszámot); ezt vedd figyelembe, ha a kérdés erre vonatkozik (pl. egy adott napi ülésre).',
    ].join(' '),
  },

  limits: {
    maxQuestionChars: 1000,
    requestsPerMinutePerIp: 20,
  },
};
