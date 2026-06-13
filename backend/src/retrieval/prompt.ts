import type { ChatTurn, Source, TenantConfig } from '@municipal-assistant/shared';
import type { ChatClient, ChatMessage } from '../llm/types.js';
import type { RetrievedChunk } from './search.js';

/** System prompt from the template, substituting {displayName}. */
export function buildSystemPrompt(config: TenantConfig): string {
  return config.rag.systemPromptTemplate.replaceAll('{displayName}', config.displayName);
}

/** Joins the results into a numbered, citable source block for the LLM. */
export function buildContextBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c, i) => {
      const meta = [c.documentTitle, c.sectionRef, c.pageNumber ? `${c.pageNumber}. o.` : null]
        .filter(Boolean)
        .join(', ');
      return `[Forrás ${i + 1}] (${meta})\n${c.content}`;
    })
    .join('\n\n');
}

/** The answer's sources for the UI; deduplicated by document + section. */
export function buildSources(chunks: RetrievedChunk[]): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const c of chunks) {
    const key = `${c.sourceUrl}#${c.sectionRef ?? ''}#${c.pageNumber ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      documentTitle: c.documentTitle,
      category: c.category,
      sourceUrl: c.sourceUrl,
      pageNumber: c.pageNumber ?? undefined,
      sectionRef: c.sectionRef ?? undefined,
    });
  }
  return sources;
}

/** The final chat messages: system prompt + context + question. */
export function buildAnswerMessages(
  config: TenantConfig,
  question: string,
  chunks: RetrievedChunk[],
): ChatMessage[] {
  const context = buildContextBlock(chunks);
  return [
    { role: 'system', content: buildSystemPrompt(config) },
    {
      role: 'user',
      content:
        `Forrásrészletek:\n\n${context}\n\n` +
        `Kérdés: ${question}\n\n` +
        `Válaszolj kizárólag a fenti forrásrészletek alapján. NE írj a szövegbe forráshivatkozást (pl. [Forrás 1]) — a forrásokat a felület külön jeleníti meg.`,
    },
  ];
}

/**
 * For a follow-up question, produces a standalone search query from the
 * conversation with a cheap LLM call (BRIEF point 3). Without history, returns
 * the original question.
 */
export async function rewriteFollowUp(
  chat: ChatClient,
  history: ChatTurn[] | undefined,
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!history || history.length === 0) return question;

  const transcript = history
    .map((t) => `${t.role === 'user' ? 'Felhasználó' : 'Asszisztens'}: ${t.content}`)
    .join('\n');
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'A feladatod: a beszélgetés alapján fogalmazz egy ÖNÁLLÓ, kereséshez használható magyar kérdést, ' +
        'amely előzmény ismerete nélkül is értelmezhető. Csak a kérdést add vissza, semmi mást.',
    },
    {
      role: 'user',
      content: `Beszélgetés:\n${transcript}\n\nKövető kérdés: ${question}\n\nÖnálló kérdés:`,
    },
  ];

  try {
    const rewritten = (await chat.complete(messages, signal)).trim();
    return rewritten || question;
  } catch {
    return question;
  }
}
