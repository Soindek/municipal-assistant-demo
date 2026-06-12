import type { TenantConfig } from '@municipal-assistant/shared';
import type { DeepPartial } from './deep-merge.js';

/**
 * Józan magyar önkormányzati alapértelmezések. A tenant-fájlok csak az
 * eltéréseket adják meg; ezeket a loader mélyen a tenant alá fésüli.
 *
 * A rendszerprompt a hallucináció-tiltást és az idézési szabályt is tartalmazza
 * (BRIEF 8. pont). A {displayName} tokent a backend helyettesíti be.
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
      'Minden állításhoz jelöld meg, melyik forrásrészletre támaszkodsz (a [Forrás N] jelölést használva).',
      'Ha több, eltérő dátumú forrás van, a frissebbet részesítsd előnyben, és jelezd a dátumot.',
    ].join(' '),
  },

  limits: {
    maxQuestionChars: 1000,
    requestsPerMinutePerIp: 20,
  },
};
