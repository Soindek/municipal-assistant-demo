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

/**
 * The answer's sources for the UI, deduplicated by DOCUMENT (one entry per
 * source URL, keeping the highest-ranked chunk's page/section). Listing every
 * retrieved chunk would show the same document several times and cite passages
 * the answer never used — see selectUsedChunks for the relevance filtering.
 */
export function buildSources(chunks: RetrievedChunk[]): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const c of chunks) {
    if (seen.has(c.sourceUrl)) continue;
    seen.add(c.sourceUrl);
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

/**
 * Narrows the retrieved chunks to the ones the answer ACTUALLY relied on, via a
 * cheap follow-up LLM call. Hybrid search returns topK chunks for context, but
 * many are only tangentially related (e.g. newsletters that mention the topic);
 * citing all of them is misleading. Falls back to all chunks if the model's
 * reply can't be parsed, so the source list is never empty for a real answer.
 */
export async function selectUsedChunks(
  chat: ChatClient,
  answer: string,
  chunks: RetrievedChunk[],
  signal?: AbortSignal,
): Promise<RetrievedChunk[]> {
  if (chunks.length <= 1) return chunks;

  const list = chunks
    .map((c, i) => {
      const meta = [c.documentTitle, c.sectionRef, c.pageNumber ? `${c.pageNumber}. o.` : null]
        .filter(Boolean)
        .join(', ');
      return `[${i + 1}] (${meta})\n${c.content.slice(0, 500)}`;
    })
    .join('\n\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Eldöntöd, mely számozott forrásrészletekre támaszkodik egy adott válasz. ' +
        'Csak azoknak a forrásoknak a számát add vissza, amelyekből a válaszban szereplő ' +
        'információ ténylegesen származik (a csak érintőlegesen kapcsolódókat hagyd ki). ' +
        'A választ kizárólag vesszővel elválasztott számokként add meg (pl. "1, 3"). ' +
        'Ha egyik forrás sem releváns, írd: "nincs".',
    },
    {
      role: 'user',
      content: `Válasz:\n${answer}\n\nForrásrészletek:\n${list}\n\nMely forrásokra támaszkodik a válasz?`,
    },
  ];

  try {
    const reply = (await chat.complete(messages, signal)).trim();
    const picked = new Set(
      [...reply.matchAll(/\d+/g)]
        .map((m) => Number(m[0]))
        .filter((n) => n >= 1 && n <= chunks.length),
    );
    if (picked.size === 0) return chunks; // unparseable / "nincs" → don't lose sources
    return chunks.filter((_, i) => picked.has(i + 1));
  } catch {
    return chunks;
  }
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
