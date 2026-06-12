import { z } from 'zod';
import type {
  DocumentSource,
  DocumentSourceContext,
  FetchedContent,
  SourceDocument,
} from '@municipal-assistant/shared';

/**
 * VARRAT #1 — `wordpress-accordion` adapter a vacratot.hu/dokumentumok oldalhoz.
 *
 * Az oldal a Document Library Pro plugint használja: a dokumentumtár egy
 * DataTables, amit JS tölt `admin-ajax.php`-ból — a statikus HTML NEM tartalmazza
 * a PDF-linkeket. Ezért fejléc nélküli böngésző helyett a WordPress REST API
 * `wp/v2/media` végpontjáról listázzuk a PDF-eket (lapozással). Ehhez nem kell
 * extra függőség (globális fetch).
 *
 * ISMERT KORLÁT (dokumentált TODO): a REST `media` nem adja vissza a Document
 * Library Pro kategória-taxonómiáját (`dlp_category`), és a teljes médiatárat
 * listázza. Ezért a kategóriát a dokumentum címéből próbáljuk kitalálni
 * (categoryMap kulcsszavak), különben a defaultCategory-ra esünk vissza.
 * Pontos kategóriákhoz a 2. körben vagy a `dlp_document` REST-kitétele kell a
 * site-on, vagy az admin-ajax DataTables válasz feldolgozása, vagy Playwright.
 */

const OptionsSchema = z.object({
  /** A dokumentum-oldal URL-je; ebből származtatjuk a REST gyökeret. */
  baseUrl: z.string().url(),
  /** Felülírható REST media végpont (különben {origin}/wp-json/wp/v2/media). */
  restMediaUrl: z.string().url().optional(),
  /** Emberi kategória-címke → TenantConfig kategória-kulcs (heurisztikához). */
  categoryMap: z.record(z.string()).optional(),
  /** Visszaesési kategória, ha a címből nem következtethető ki. */
  defaultCategory: z.string().default('rendeletek'),
  /** Mely mime-típusokat listázzuk. */
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

/** Egyszerű HTML-entitás dekódolás + tagek eltávolítása a címekhez. */
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

/** Magyar többes-szám levágása a kategória-címkékről (best-effort). */
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
    .sort((a, b) => b.keyword.length - a.keyword.length); // specifikusabb előbb
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
            ctx.logger.warn(`wordpress-accordion: REST hiba ${res.status} @ ${url.toString()}`);
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
              // modified_gmt változik, ha a fájlt cserélik → jó változás-token.
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
        throw new Error(`Letöltés sikertelen (${res.status}): ${doc.sourceUrl}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { externalId: doc.externalId, bytes, mimeType: doc.mimeType };
    },
  };
}
