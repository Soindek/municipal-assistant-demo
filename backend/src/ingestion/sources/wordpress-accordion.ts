import { z } from 'zod';
import type {
  DocumentSource,
  DocumentSourceContext,
  FetchedContent,
  SourceDocument,
} from '@municipal-assistant/shared';

/**
 * SEAM #1 — `wordpress-accordion` adapter for the vacratot.hu/dokumentumok page.
 *
 * The page uses the Document Library Pro plugin: the document library is a
 * DataTables loaded by JS from `admin-ajax.php` — the static HTML does NOT
 * contain the PDF links. So instead of a headless browser, we list the PDFs
 * from the WordPress REST API `wp/v2/media` endpoint (with pagination). This
 * needs no extra dependency (global fetch).
 *
 * KNOWN LIMITATION (documented TODO): REST `media` does not return the Document
 * Library Pro category taxonomy (`dlp_category`), and lists the entire media
 * library. So we try to infer the category from the document title (categoryMap
 * keywords), otherwise we fall back to defaultCategory. For accurate categories,
 * round 2 needs either exposing `dlp_document` via REST on the site, processing
 * the admin-ajax DataTables response, or Playwright.
 */

const OptionsSchema = z.object({
  /** The document page URL; we derive the REST root from it. */
  baseUrl: z.string().url(),
  /** Overridable REST media endpoint (otherwise {origin}/wp-json/wp/v2/media). */
  restMediaUrl: z.string().url().optional(),
  /** Human category label → TenantConfig category key (for the heuristic). */
  categoryMap: z.record(z.string()).optional(),
  /** Fallback category if it cannot be inferred from the title. */
  defaultCategory: z.string().default('rendeletek'),
  /** Which mime types to list. */
  mimeTypes: z.array(z.string()).default(['application/pdf']),
  perPage: z.number().int().positive().max(100).default(100),
  userAgent: z.string().default('municipal-assistant/0.1 (+ingestion)'),
});

interface MediaItem {
  id: number;
  date_gmt?: string;
  modified_gmt?: string;
  mime_type?: string;
  source_url?: string;
  title?: { rendered?: string };
}

/** Simple HTML entity decoding + tag removal for titles. */
function decodeHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

/** Strips the Hungarian plural from category labels (best-effort). */
function stripPlural(label: string): string {
  return label
    .toLowerCase()
    .replace(/(ek|ök|ok|ák|k)$/u, '')
    .trim();
}

interface CategoryKeyword {
  keyword: string;
  key: string;
}

function buildCategoryKeywords(categoryMap?: Record<string, string>): CategoryKeyword[] {
  if (!categoryMap) return [];
  return Object.entries(categoryMap)
    .map(([label, key]) => ({ keyword: stripPlural(label), key }))
    .filter((c) => c.keyword.length >= 4)
    .sort((a, b) => b.keyword.length - a.keyword.length); // more specific first
}

function inferCategory(title: string, keywords: CategoryKeyword[], fallback: string): string {
  const t = title.toLowerCase();
  for (const { keyword, key } of keywords) {
    if (t.includes(keyword)) return key;
  }
  return fallback;
}

export function createWordpressAccordionSource(options: Record<string, unknown>): DocumentSource {
  const opts = OptionsSchema.parse(options);
  const mediaUrl = opts.restMediaUrl ?? new URL('/wp-json/wp/v2/media', opts.baseUrl).toString();
  const keywords = buildCategoryKeywords(opts.categoryMap);

  return {
    name: 'wordpress-accordion',

    async *list(ctx: DocumentSourceContext): AsyncIterable<SourceDocument> {
      for (const mime of opts.mimeTypes) {
        let page = 1;
        let totalPages = 1;
        do {
          const url = new URL(mediaUrl);
          url.searchParams.set('mime_type', mime);
          url.searchParams.set('per_page', String(opts.perPage));
          url.searchParams.set('page', String(page));
          url.searchParams.set('_fields', 'id,date_gmt,modified_gmt,mime_type,source_url,title');

          const res = await fetch(url, {
            headers: { 'User-Agent': opts.userAgent },
            signal: ctx.signal,
          });
          if (!res.ok) {
            ctx.logger.warn(`wordpress-accordion: REST error ${res.status} @ ${url.toString()}`);
            break;
          }
          totalPages = Number(res.headers.get('x-wp-totalpages') ?? '1') || 1;
          const items = (await res.json()) as MediaItem[];

          for (const item of items) {
            if (!item.source_url) continue;
            const title = decodeHtml(item.title?.rendered ?? '') || `media-${item.id}`;
            yield {
              externalId: `media:${item.id}`,
              title,
              category: inferCategory(title, keywords, opts.defaultCategory),
              sourceUrl: item.source_url,
              mimeType: item.mime_type ?? mime,
              // modified_gmt changes when the file is replaced → good change token.
              changeToken: item.modified_gmt ?? null,
              publishedAt: item.date_gmt ? new Date(`${item.date_gmt}Z`) : null,
              language: 'hu',
            };
          }
          page++;
        } while (page <= totalPages);
      }
    },

    async fetch(doc: SourceDocument, ctx: DocumentSourceContext): Promise<FetchedContent> {
      const res = await fetch(doc.sourceUrl, {
        headers: { 'User-Agent': opts.userAgent },
        signal: ctx.signal,
      });
      if (!res.ok) {
        throw new Error(`Download failed (${res.status}): ${doc.sourceUrl}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { externalId: doc.externalId, bytes, mimeType: doc.mimeType };
    },
  };
}
