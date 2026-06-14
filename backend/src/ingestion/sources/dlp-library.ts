import * as cheerio from 'cheerio';
import { z } from 'zod';
import type {
  DocumentSource,
  DocumentSourceContext,
  FetchedContent,
  SourceDocument,
} from '@municipal-assistant/shared';

/**
 * SEAM #1 — `dlp-library` adapter: the CURATED Document Library Pro list on
 * vacratot.hu/dokumentumok (the canonical source), not the wp/v2/media library.
 *
 * The page renders a folder tree (one folder per dlp_category) and loads each
 * folder's table via admin-ajax.php (action=dlp_fetch_table). With
 * serverSide:false the response contains the FULL table (all rows) in one call,
 * so no DataTables pagination is needed. Each row gives the real category, the
 * document page and the file URL (which may be an EXTERNAL link, e.g. njt.hu).
 *
 * The WordPress nonce is read fresh from the page on every run (it expires).
 */

const OptionsSchema = z.object({
  baseUrl: z.string().url().default('https://vacratot.hu'),
  /** The page hosting the DLP folder tree + nonces. */
  documentsPath: z.string().default('/dokumentumok/'),
  /** DLP folder name → TenantConfig category key. */
  categoryMap: z.record(z.string()).optional(),
  /** Category for folders not present in categoryMap. */
  defaultCategory: z.string().default('rendeletek'),
  /** DLP folder names to skip (e.g. ones covered authoritatively by another source). */
  excludeCategories: z.array(z.string()).default([]),
  requestTimeoutMs: z.number().int().positive().default(30000),
  requestDelayMs: z.number().int().min(0).default(800),
  userAgent: z.string().default('municipal-assistant/0.1 (+ingestion)'),
});

export interface DlpCategory {
  id: string;
  name: string;
}

export interface DlpPageConfig {
  ajaxUrl: string;
  foldersNonce: string;
  shortcodeAtts: string;
  categories: DlpCategory[];
}

export interface DlpRow {
  title: string;
  /** The DLP single-document page (/document/<slug>/) — stable id + citation. */
  docPageUrl: string | null;
  /** The actual file (uploads PDF) or an external URL (njt.hu, Drive). */
  fileUrl: string | null;
}

/** Parses the /dokumentumok/ page: ajax url, dlp_fetch_table nonce, folders. */
export function parseFolderPage(html: string): DlpPageConfig {
  const ajaxUrl = (html.match(/"ajax_url":"([^"]+)"/)?.[1] ?? '').replace(/\\\//g, '/');
  const foldersNonce =
    html.match(/"ajax_nonce":"([a-f0-9]+)","ajax_action":"dlp_fetch_table"/)?.[1] ?? '';
  const shortcodeAtts =
    html.match(/data-shortcode-atts='([^']+)'/)?.[1] ?? '{"post_type":"dlp_document"}';

  const $ = cheerio.load(html);
  const categories: DlpCategory[] = [];
  const seen = new Set<string>();
  $('[data-category-id]').each((_, el) => {
    const id = $(el).attr('data-category-id')?.trim();
    if (!id || seen.has(id)) return;
    const name = $(el).find('.dlp-category-name').first().text().trim();
    if (name) {
      seen.add(id);
      categories.push({ id, name });
    }
  });

  return { ajaxUrl, foldersNonce, shortcodeAtts, categories };
}

/** Parses the dlp_fetch_table response HTML (full table) into rows. */
export function parseTableRows(html: string): DlpRow[] {
  const $ = cheerio.load(html);
  const rows: DlpRow[] = [];
  $('tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const title = $tr.find('td').first().text().replace(/\s+/g, ' ').trim();
    if (!title) return;

    let docPageUrl: string | null = null;
    let fileUrl: string | null = null;
    $tr.find('a[href]').each((_, a) => {
      const href = ($(a).attr('href') ?? '').trim();
      if (!/^https?:\/\//i.test(href)) return; // skip javascript:void(0) etc.
      if (/\/document\//.test(href) && !/\/document-category\//.test(href)) {
        docPageUrl ??= href;
      } else if (!/\/document-category\//.test(href)) {
        // The file: an uploads URL or an external link (njt.hu, Drive).
        fileUrl ??= href;
      }
    });
    rows.push({ title, docPageUrl, fileUrl });
  });
  return rows;
}

function mimeFromUrl(url: string): string {
  const ext = url.split('?')[0]!.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'txt') return 'text/plain';
  return 'application/octet-stream';
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

export function createDlpLibrarySource(options: Record<string, unknown>): DocumentSource {
  const opts = OptionsSchema.parse(options);

  const withTimeout = (signal: AbortSignal | undefined): AbortSignal => {
    const t = AbortSignal.timeout(opts.requestTimeoutMs);
    return signal ? AbortSignal.any([signal, t]) : t;
  };

  const mapCategory = (folderName: string): string =>
    opts.categoryMap?.[folderName] ?? opts.defaultCategory;

  return {
    name: 'dlp-library',

    async *list(ctx: DocumentSourceContext): AsyncIterable<SourceDocument> {
      // 1) Read the page: fresh nonce + folder/category map.
      const pageRes = await fetch(`${opts.baseUrl}${opts.documentsPath}`, {
        headers: { 'User-Agent': opts.userAgent, Accept: 'text/html' },
        signal: withTimeout(ctx.signal),
      });
      if (!pageRes.ok) throw new Error(`dlp page failed (${pageRes.status})`);
      const cfg = parseFolderPage(await pageRes.text());
      if (!cfg.foldersNonce || cfg.categories.length === 0) {
        throw new Error('dlp: could not extract nonce/categories from the page');
      }
      ctx.logger.info(`dlp: ${cfg.categories.length} categories found`);

      const seenDocs = new Set<string>();
      // 2) For each folder, fetch its full table and yield rows.
      for (const cat of cfg.categories) {
        if (opts.excludeCategories.includes(cat.name)) {
          ctx.logger.info(`dlp: skipping "${cat.name}" (excluded)`);
          continue;
        }
        const body = new URLSearchParams({
          action: 'dlp_fetch_table',
          _ajax_nonce: cfg.foldersNonce,
          category_id: cat.id,
          shortcode_atts: cfg.shortcodeAtts,
        });
        const res = await fetch(cfg.ajaxUrl, {
          method: 'POST',
          headers: {
            'User-Agent': opts.userAgent,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
          signal: withTimeout(ctx.signal),
        });
        if (!res.ok) {
          ctx.logger.warn(`dlp: fetch_table failed for "${cat.name}" (${res.status})`);
          continue;
        }
        const payload = (await res.json()) as { html?: string; layout?: string };
        const rows = parseTableRows(payload.html ?? '');
        ctx.logger.info(`dlp: "${cat.name}" → ${rows.length} documents`);

        for (const row of rows) {
          const fileUrl = row.fileUrl;
          if (!fileUrl) {
            ctx.logger.warn(`dlp: no file URL for "${row.title}" (${cat.name})`);
            continue;
          }
          const externalId = row.docPageUrl ?? fileUrl;
          if (seenDocs.has(externalId)) continue; // a doc may appear in several folders
          seenDocs.add(externalId);

          yield {
            externalId,
            title: row.title,
            category: mapCategory(cat.name),
            sourceUrl: row.docPageUrl ?? fileUrl,
            mimeType: mimeFromUrl(fileUrl),
            // No date/version in the DLP table → use the file URL as change token.
            changeToken: fileUrl,
            publishedAt: null,
            language: 'hu',
            metadata: { fileUrl, dlpCategory: cat.name },
          };
        }
        await delay(opts.requestDelayMs, ctx.signal);
      }
    },

    async fetch(doc: SourceDocument, ctx: DocumentSourceContext): Promise<FetchedContent> {
      const fileUrl = (doc.metadata?.fileUrl as string | undefined) ?? doc.sourceUrl;
      const res = await fetch(fileUrl, {
        headers: { 'User-Agent': opts.userAgent },
        signal: withTimeout(ctx.signal),
      });
      if (!res.ok) throw new Error(`dlp download failed (${res.status}): ${fileUrl}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { externalId: doc.externalId, bytes, mimeType: doc.mimeType };
    },
  };
}
