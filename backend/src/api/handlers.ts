import type { RequestHandler } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { run } from '../ingestion/run.js';
import { buildAnswerMessages, buildSources, rewriteFollowUp } from '../retrieval/prompt.js';
import { hybridSearch } from '../retrieval/search.js';
import type { ApiDeps } from './deps.js';
import { initSse, sendEvent } from './sse.js';

/** GET /api/health — készenléti ellenőrzés (DB elérhetőség is). */
export function createHealthHandler(deps: ApiDeps): RequestHandler {
  return async (_req, res) => {
    try {
      await getPool().query('SELECT 1');
      res.json({
        status: 'ok',
        tenant: deps.config.tenantId,
        chatModel: deps.config.rag.chatModel,
      });
    } catch {
      res.status(503).json({ status: 'degraded', db: false });
    }
  };
}

/** POST /api/ask — a teljes RAG út, SSE-streamelt válasszal. */
export function createAskHandler(deps: ApiDeps): RequestHandler {
  const { config, llm } = deps;

  const BodySchema = z.object({
    question: z
      .string()
      .trim()
      .min(1, 'A kérdés nem lehet üres')
      .max(config.limits.maxQuestionChars),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
      .max(20)
      .optional(),
  });

  return async (req, res) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Érvénytelen kérés', details: parsed.error.issues });
      return;
    }
    const { question, history } = parsed.data;

    initSse(res);
    const ac = new AbortController();
    // Csak akkor szakítsuk meg, ha a kliens bontott a válasz befejezése ELŐTT.
    // (req 'close' túl korán tüzelne — a body beolvasása után azonnal.)
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });

    try {
      // 1) Követő kérdés → önálló keresési kérdés.
      const searchQuery = await rewriteFollowUp(llm.chat, history, question, ac.signal);

      // 2) Beágyazás + hibrid keresés.
      const embeddings = await llm.embedding.embed([searchQuery], ac.signal);
      const queryEmbedding = embeddings[0];
      if (!queryEmbedding) throw new Error('Sikertelen beágyazás a kérdéshez.');

      const chunks = await hybridSearch(queryEmbedding, searchQuery, config.rag.topK);
      const bestSimilarity = chunks[0]?.similarity ?? 0;

      // 3) Guardrail: nincs elég jó találat → "nem tudom" (BRIEF 8. pont).
      if (chunks.length === 0 || bestSimilarity < config.rag.minScore) {
        sendEvent(res, {
          type: 'token',
          text: 'Sajnálom, ezt nem találom a rendelkezésre álló hivatalos dokumentumokban. Javaslom, forduljon közvetlenül a hivatalhoz.',
        });
        sendEvent(res, { type: 'sources', sources: [] });
        sendEvent(res, { type: 'done' });
        res.end();
        return;
      }

      // 4) Válasz streamelése + a végén a források.
      const messages = buildAnswerMessages(config, question, chunks);
      await llm.chat.streamChat(
        messages,
        (text) => sendEvent(res, { type: 'token', text }),
        ac.signal,
      );
      sendEvent(res, { type: 'sources', sources: buildSources(chunks) });
      sendEvent(res, { type: 'done' });
      res.end();
    } catch (err) {
      if (!ac.signal.aborted) {
        sendEvent(res, { type: 'error', message: (err as Error).message });
      }
      res.end();
    }
  };
}

/** POST /api/reindex — védett, kézi betöltés-indítás (BRIEF 7. pont). */
export function createReindexHandler(deps: ApiDeps): RequestHandler {
  return async (req, res) => {
    const token = deps.env.REINDEX_TOKEN;
    if (!token) {
      res.status(503).json({ error: 'A reindex nincs engedélyezve (állíts be REINDEX_TOKEN-t).' });
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: 'Hiányzó vagy érvénytelen token.' });
      return;
    }
    try {
      const stats = await run();
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  };
}
