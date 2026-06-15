import * as cheerio from 'cheerio';
import { z } from 'zod';
import type {
  DocumentSource,
  DocumentSourceContext,
  FetchedContent,
  SourceDocument,
} from '@municipal-assistant/shared';

/**
 * SEAM #1 — `wordpress-pages` adapter: the municipality's static WordPress
 * PAGES (wp/v2/pages), e.g. office info, services, contact. NOT posts — those
 * are time-bound news and would dilute the answer.
 *
 * Content comes straight from the REST API (content.rendered), so there is no
 * HTML scraping of the live theme: the REST body excludes nav/header/footer.
 * The HTML is cleaned to plain text here; no OCR is needed.
 *
 * Trivial pages (empty, or just a document-list/PDF embed with little prose)
 * are filtered out so they don't dilute retrieval or duplicate DLP documents.
 */

const OptionsSchema = z.object({
  baseUrl: z.string().url().default('https://vacratot.hu'),
  apiPath: z.string().default('/wp-json/wp/v2/pages'),
  category: z.string().default('oldalak'),
  perPage: z.number().int().positive().max(100).default(100),
  /** Skip pages whose cleaned text has fewer words than this (near-empty/embeds). */
  minWords: z.number().int().min(0).default(10),
  /**
   * Page slugs to skip regardless of length — typically pages that only embed
   * the DLP document list (avoids duplicating DLP documents). Word count alone
   * can't tell these from short-but-useful contact pages, so exclude by slug.
   */
  excludeSlugs: z.array(z.string()).default(['dokumentumok', 'document-library']),
  requestTimeoutMs: z.number().int().positive().default(30000),
  requestDelayMs: z.number().int().min(0).default(300),
  userAgent: z.string().default('municipal-assistant/0.1 (+ingestion)'),
});

interface WpPage {
  id: number;
  slug: string;
  status: string;
  link: string;
  modified_gmt: string;
  date_gmt: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
}

/** Decodes entities and strips tags from a small HTML fragment (e.g. a title). */
export function htmlFragmentToText(html: string): string {
  // \s also matches the non-breaking space, so entity-decoded &nbsp; collapses too.
  return cheerio
    .load(`<x>${html}</x>`)('x')
    .text()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cleans a WordPress content.rendered HTML body into plain text. */
export function cleanContent(html: string): string {
  const $ = cheerio.load(html);
  // Drop non-content / noise nodes.
  $(
    'script, style, noscript, iframe, figure, figcaption, .wp-caption-text, .screen-reader-text',
  ).remove();
  // Force block-level separation so words don't run together.
  $('p, br, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote').each((_i, el) => {
    $(el).append('\n');
  });

  return $.root()
    .text()
    // Leftover (unexpanded) shortcodes like [pdf id=12] or [/embed].
    .replace(/\[\/?[a-z][a-z0-9_-]*(?:\s[^\]]*)?\]/gi, ' ')
    // Collapse horizontal whitespace (incl. non-breaking spaces) but keep newlines.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export function createWordpressPagesSource(options: Record<string, unknown>): DocumentSource {
  const opts = OptionsSchema.parse(options);

  const withTimeout = (signal: AbortSignal | undefined): AbortSignal => {
    const t = AbortSignal.timeout(opts.requestTimeoutMs);
    return signal ? AbortSignal.any([signal, t]) : t;
  };

  const fetchPage = async (
    page: number,
    signal: AbortSignal | undefined,
  ): Promise<{ items: WpPage[]; totalPages: number }> => {
    const url = `${opts.baseUrl}${opts.apiPath}?per_page=${opts.perPage}&page=${page}&_fields=id,slug,status,link,modified_gmt,date_gmt,title,content`;
    const res = await fetch(url, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' },
      signal: withTimeout(signal),
    });
    if (!res.ok) throw new Error(`wp pages failed (${res.status}) page=${page}`);
    const totalPages = Number(res.headers.get('x-wp-totalpages') ?? '1');
    const items = (await res.json()) as WpPage[];
    return { items, totalPages };
  };

  return {
    name: 'wordpress-pages',

    async *list(ctx: DocumentSourceContext): AsyncIterable<SourceDocument> {
      const first = await fetchPage(1, ctx.signal);
      const totalPages = Number.isFinite(first.totalPages) ? first.totalPages : 1;
      ctx.logger.info(`wp-pages: ${totalPages} page(s) of results`);

      let skipped = 0;
      let yielded = 0;

      const buildDocs = function* (items: WpPage[]): Generator<SourceDocument> {
        for (const p of items) {
          if (p.status !== 'publish') {
            skipped++;
            continue;
          }
          if (opts.excludeSlugs.includes(p.slug)) {
            skipped++;
            ctx.logger.info(`wp-pages: skipping excluded page "${p.slug}" (doc-list/dedup) ${p.link}`);
            continue;
          }
          const title = htmlFragmentToText(p.title?.rendered ?? '') || `oldal ${p.id}`;
          const text = cleanContent(p.content?.rendered ?? '');
          if (wordCount(text) < opts.minWords) {
            skipped++;
            ctx.logger.info(
              `wp-pages: skipping trivial page "${title}" (${wordCount(text)} words) ${p.link}`,
            );
            continue;
          }
          yielded++;
          yield {
            externalId: `page:${p.id}`,
            title,
            category: opts.category,
            sourceUrl: p.link,
            mimeType: 'text/plain',
            changeToken: p.modified_gmt,
            publishedAt: p.date_gmt ? new Date(`${p.date_gmt}Z`) : null,
            language: 'hu',
            // Content already retrieved with the listing — carry it so fetch()
            // needs no second request.
            metadata: { text },
          };
        }
      };

      yield* buildDocs(first.items);
      for (let page = 2; page <= totalPages; page++) {
        await delay(opts.requestDelayMs, ctx.signal);
        const { items } = await fetchPage(page, ctx.signal);
        yield* buildDocs(items);
      }

      ctx.logger.info(`wp-pages: ${yielded} page(s) to ingest, ${skipped} skipped (trivial/non-publish)`);
    },

    fetch(doc: SourceDocument): Promise<FetchedContent> {
      const text = (doc.metadata?.text as string | undefined) ?? '';
      return Promise.resolve({
        externalId: doc.externalId,
        bytes: new TextEncoder().encode(text),
        mimeType: 'text/plain',
      });
    },
  };
}
