// ───────────────────────── shared/src/dto.ts ─────────────────────────
// Shared DTOs for the frontend and backend. A single source of truth.

/** A single conversation turn (context for follow-up questions). */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** A source citation for an answer — the UI builds a clickable link from it. */
export interface Source {
  documentTitle: string;
  category: string;
  sourceUrl: string;
  pageNumber?: number;
  sectionRef?: string; // e.g. "12. §"
}

export interface AskRequest {
  question: string;
  history?: ChatTurn[];
}

/** SSE event types in the /api/ask stream. */
export type AskEvent =
  | { type: 'token'; text: string } // partial answer text
  | { type: 'sources'; sources: Source[] } // the answer's sources (at the end)
  | { type: 'done'; queryId?: string | null } // queryId: for attaching 👍/👎 feedback
  | { type: 'error'; message: string };

/** POST /api/feedback body — 👍/👎 on a logged answer (referenced by queryId). */
export interface FeedbackRequest {
  queryId: string;
  rating: 'up' | 'down';
  comment?: string;
}
