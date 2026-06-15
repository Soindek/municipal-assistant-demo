import type { RequestHandler } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { insertQueryLog, type QueryLogInput } from '../db/repositories/query-log.js';
import { run } from '../ingestion/run.js';
import { consoleLogger } from '../logger.js';
import {
  buildAnswerMessages,
  buildSources,
  rewriteFollowUp,
  selectUsedChunks,
} from '../retrieval/prompt.js';
import { hybridSearch } from '../retrieval/search.js';
import type { ApiDeps } from './deps.js';
import { initSse, sendEvent } from './sse.js';

/** Fallback answer when retrieval finds nothing good enough (BRIEF point 8). */
const NO_ANSWER =
  'Sajnálom, ezt nem találom a rendelkezésre álló hivatalos dokumentumokban. Javaslom, forduljon közvetlenül a hivatalhoz.';

/** Fire-and-forget query logging; never breaks the response on failure. */
function logQuery(entry: QueryLogInput): void {
  void insertQueryLog(entry).catch((err) =>
    consoleLogger.warn(`query_log insert failed: ${(err as Error).message}`),
  );
}

/**
 * GET /api/config — tenant branding + limits for the UI. Exposes only public,
 * non-secret fields so the frontend hardcodes nothing (seam #2 stays clean).
 */
export function createConfigHandler(deps: ApiDeps): RequestHandler {
  const { config } = deps;
  return (_req, res) => {
    res.json({
      displayName: config.displayName,
      locale: config.locale,
      branding: {
        welcomeMessage: config.branding.welcomeMessage,
        disclaimer: config.branding.disclaimer,
        primaryColor: config.branding.primaryColor ?? null,
        logoUrl: config.branding.logoUrl ?? null,
      },
      limits: {
        maxQuestionChars: config.limits.maxQuestionChars,
      },
    });
  };
}

/** GET /api/health — readiness check (including DB availability). */
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

/** POST /api/ask — the full RAG path, with an SSE-streamed answer. */
export function createAskHandler(deps: ApiDeps): RequestHandler {
  const { config, llm } = deps;

  const BodySchema = z.object({
    question: z
      .string()
      .trim()
      .min(1, 'The question cannot be empty')
      .max(config.limits.maxQuestionChars),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
      .max(20)
      .optional(),
  });

  return async (req, res) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }
    const { question, history } = parsed.data;

    initSse(res);
    const ac = new AbortController();
    // Only abort if the client disconnected BEFORE the response finished.
    // (req 'close' would fire too early — right after the body is read.)
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });

    try {
      // 1) Follow-up question → standalone search query.
      const searchQuery = await rewriteFollowUp(llm.chat, history, question, ac.signal);

      // 2) Embedding + hybrid search.
      const embeddings = await llm.embedding.embed([searchQuery], ac.signal);
      const queryEmbedding = embeddings[0];
      if (!queryEmbedding) throw new Error('Failed to embed the question.');

      const chunks = await hybridSearch(queryEmbedding, searchQuery, config.rag.topK);
      const bestSimilarity = chunks[0]?.similarity ?? 0;

      // 3) Guardrail: no good-enough match → "I don't know" (BRIEF point 8).
      if (chunks.length === 0 || bestSimilarity < config.rag.minScore) {
        sendEvent(res, { type: 'token', text: NO_ANSWER });
        sendEvent(res, { type: 'sources', sources: [] });
        sendEvent(res, { type: 'done' });
        res.end();
        logQuery({
          question,
          rewrittenQuery: searchQuery,
          answer: NO_ANSWER,
          retrievedChunkIds: [],
        });
        return;
      }

      // 4) Stream the answer + the sources at the end.
      const messages = buildAnswerMessages(config, question, chunks);
      const answer = await llm.chat.streamChat(
        messages,
        (text) => sendEvent(res, { type: 'token', text }),
        ac.signal,
      );
      // Cite only the sources the answer actually used (deduped by document).
      const usedChunks = await selectUsedChunks(llm.chat, answer, chunks, ac.signal);
      sendEvent(res, { type: 'sources', sources: buildSources(usedChunks) });
      sendEvent(res, { type: 'done' });
      res.end();
      logQuery({
        question,
        rewrittenQuery: searchQuery,
        answer,
        retrievedChunkIds: chunks.map((c) => c.chunkId),
      });
    } catch (err) {
      if (!ac.signal.aborted) {
        sendEvent(res, { type: 'error', message: (err as Error).message });
      }
      res.end();
    }
  };
}

/** POST /api/reindex — protected, manual ingestion trigger (BRIEF point 7). */
export function createReindexHandler(deps: ApiDeps): RequestHandler {
  return async (req, res) => {
    const token = deps.env.REINDEX_TOKEN;
    if (!token) {
      res.status(503).json({ error: 'Reindex is not enabled (set REINDEX_TOKEN).' });
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: 'Missing or invalid token.' });
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
