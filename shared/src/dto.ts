// ───────────────────────── shared/src/dto.ts ─────────────────────────
// A frontend és a backend közös DTO-jai. Egyetlen forrás az igazságról.

/** Egy beszélgetési forduló (követő kérdések kontextusához). */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Forrásmegjelölés egy válaszhoz — ebből épít a UI kattintható hivatkozást. */
export interface Source {
  documentTitle: string;
  category: string;
  sourceUrl: string;
  pageNumber?: number;
  sectionRef?: string; // pl. "12. §"
}

export interface AskRequest {
  question: string;
  history?: ChatTurn[];
}

/** SSE-eseménytípusok a /api/ask streamben. */
export type AskEvent =
  | { type: 'token'; text: string } // részleges válaszszöveg
  | { type: 'sources'; sources: Source[] } // a válasz forrásai (a végén)
  | { type: 'done' }
  | { type: 'error'; message: string };
