import type { ChatTurn, Source, TenantConfig } from '@municipal-assistant/shared';
import type { ChatClient, ChatMessage } from '../llm/types.js';
import type { RetrievedChunk } from './search.js';

/** Rendszerprompt a sablonból, a {displayName} behelyettesítésével. */
export function buildSystemPrompt(config: TenantConfig): string {
  return config.rag.systemPromptTemplate.replaceAll('{displayName}', config.displayName);
}

/** A találatokat számozott, idézhető [Forrás N] blokká fűzi az LLM-nek. */
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

/** A válasz forrásai a UI-nak; dokumentum+szakasz szerint deduplikálva. */
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

/** A végső chat-üzenetek: rendszerprompt + kontextus + kérdés. */
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
        `Válaszolj kizárólag a fenti forrásrészletek alapján, és hivatkozz rájuk [Forrás N] formában.`,
    },
  ];
}

/**
 * Követő kérdésnél a beszélgetésből önálló keresési kérdést gyárt egy olcsó
 * LLM-hívással (BRIEF 3. pont). Előzmény nélkül az eredeti kérdést adja vissza.
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
