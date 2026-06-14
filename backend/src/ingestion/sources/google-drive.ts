import * as cheerio from 'cheerio';
import { z } from 'zod';
import type {
  DocumentSource,
  DocumentSourceContext,
  FetchedContent,
  SourceDocument,
} from '@municipal-assistant/shared';

/**
 * SEAM #1 — `google-drive` adapter: a PUBLIC Google Drive folder (the "Üvegzseb"
 * transparency portal). No API key or service account is needed.
 *
 * Discovery uses the public `embeddedfolderview` endpoint, which returns a plain
 * HTML listing of a folder's immediate children. The tree is traversed
 * recursively: legacy `0B…` folders carry a `resourcekey`, newer `1…` ones do
 * not. Files are downloaded via `uc?export=download` (which serves the bytes as
 * octet-stream, so the real mime is derived from the filename extension).
 */

const OptionsSchema = z.object({
  /** Root folder id (from the share link's /folders/<id>). */
  folderId: z.string().min(1),
  /** Root folder resource key (the `resourcekey=` query param), if any. */
  resourceKey: z.string().optional(),
  /** Category for everything found under the folder. */
  category: z.string().default('uvegzseb'),
  baseUrl: z.string().url().default('https://drive.google.com'),
  /** Safety bound on recursion depth. */
  maxDepth: z.number().int().positive().default(8),
  requestTimeoutMs: z.number().int().positive().default(30000),
  requestDelayMs: z.number().int().min(0).default(500),
  userAgent: z.string().default('municipal-assistant/0.1 (+ingestion)'),
});

export interface DriveEntry {
  /** Drive file or folder id. */
  id: string;
  title: string;
  isFolder: boolean;
  /** Present for legacy resource-key-protected items. */
  resourceKey: string | null;
}

function mimeFromName(name: string): string {
  const ext = name.split('?')[0]!.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'txt':
      return 'text/plain';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

/** Drops a trailing file extension for a cleaner display title. */
function stripExt(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
}

/** Parses an embeddedfolderview HTML listing into its immediate child entries. */
export function parseFolderListing(html: string): DriveEntry[] {
  const $ = cheerio.load(html);
  const entries: DriveEntry[] = [];
  const seen = new Set<string>();
  $('.flip-entry').each((_, el) => {
    const title = $(el).find('.flip-entry-title').first().text().trim();
    let href = '';
    $(el)
      .find('a[href]')
      .each((_i, a) => {
        const h = ($(a).attr('href') ?? '').trim();
        if (/\/drive\/folders\/|\/file\/d\//.test(h)) {
          href = h;
          return false; // stop at the first folder/file link
        }
        return undefined;
      });
    if (!href || !title) return;

    const folderMatch = href.match(/\/drive\/folders\/([A-Za-z0-9_-]+)/);
    const fileMatch = href.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
    const id = folderMatch?.[1] ?? fileMatch?.[1];
    if (!id || seen.has(id)) return;
    seen.add(id);

    const resourceKey = href.match(/[?&]resourcekey=([A-Za-z0-9_-]+)/)?.[1] ?? null;
    entries.push({ id, title, isFolder: Boolean(folderMatch), resourceKey });
  });
  return entries;
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

export function createGoogleDriveSource(options: Record<string, unknown>): DocumentSource {
  const opts = OptionsSchema.parse(options);

  const withTimeout = (signal: AbortSignal | undefined): AbortSignal => {
    const t = AbortSignal.timeout(opts.requestTimeoutMs);
    return signal ? AbortSignal.any([signal, t]) : t;
  };

  const listFolder = async (
    id: string,
    resourceKey: string | null,
    signal: AbortSignal | undefined,
  ): Promise<DriveEntry[]> => {
    const params = new URLSearchParams({ id });
    if (resourceKey) params.set('resourcekey', resourceKey);
    const res = await fetch(`${opts.baseUrl}/embeddedfolderview?${params.toString()}#list`, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'text/html' },
      signal: withTimeout(signal),
    });
    if (!res.ok) throw new Error(`drive folderview failed (${res.status}) for ${id}`);
    return parseFolderListing(await res.text());
  };

  return {
    name: 'google-drive',

    async *list(ctx: DocumentSourceContext): AsyncIterable<SourceDocument> {
      const visited = new Set<string>();
      const seenFiles = new Set<string>();
      // DFS over the folder tree, carrying the breadcrumb path for context.
      const stack: Array<{
        id: string;
        resourceKey: string | null;
        path: string[];
        depth: number;
      }> = [{ id: opts.folderId, resourceKey: opts.resourceKey ?? null, path: [], depth: 0 }];

      while (stack.length > 0) {
        const folder = stack.pop()!;
        if (visited.has(folder.id)) continue;
        visited.add(folder.id);

        let entries: DriveEntry[];
        try {
          entries = await listFolder(folder.id, folder.resourceKey, ctx.signal);
        } catch (err) {
          ctx.logger.warn(`drive: folder ${folder.id} failed: ${(err as Error).message}`);
          continue;
        }
        ctx.logger.info(`drive: "${folder.path.join(' / ') || 'root'}" → ${entries.length} entries`);

        for (const entry of entries) {
          if (entry.isFolder) {
            if (folder.depth + 1 > opts.maxDepth) {
              ctx.logger.warn(`drive: max depth reached, skipping folder "${entry.title}"`);
              continue;
            }
            stack.push({
              id: entry.id,
              resourceKey: entry.resourceKey,
              path: [...folder.path, entry.title],
              depth: folder.depth + 1,
            });
            continue;
          }

          if (seenFiles.has(entry.id)) continue;
          seenFiles.add(entry.id);

          const breadcrumb = [...folder.path, stripExt(entry.title)].filter(Boolean).join(' / ');
          const viewQuery = entry.resourceKey ? `?resourcekey=${entry.resourceKey}` : '';
          yield {
            externalId: entry.id,
            title: breadcrumb,
            category: opts.category,
            sourceUrl: `${opts.baseUrl}/file/d/${entry.id}/view${viewQuery}`,
            mimeType: mimeFromName(entry.title),
            // embeddedfolderview gives no reliable modified time; the id is stable,
            // so re-runs skip already-ingested files (the archive is static).
            changeToken: entry.id,
            publishedAt: null,
            language: 'hu',
            metadata: {
              fileId: entry.id,
              resourceKey: entry.resourceKey,
              folderPath: folder.path.join('/'),
            },
          };
        }
        await delay(opts.requestDelayMs, ctx.signal);
      }
    },

    async fetch(doc: SourceDocument, ctx: DocumentSourceContext): Promise<FetchedContent> {
      const fileId = (doc.metadata?.fileId as string | undefined) ?? doc.externalId;
      const resourceKey = (doc.metadata?.resourceKey as string | null | undefined) ?? null;
      const params = new URLSearchParams({ export: 'download', id: fileId });
      if (resourceKey) params.set('resourcekey', resourceKey);

      const res = await fetch(`${opts.baseUrl}/uc?${params.toString()}`, {
        headers: { 'User-Agent': opts.userAgent },
        signal: withTimeout(ctx.signal),
      });
      if (!res.ok) throw new Error(`drive download failed (${res.status}): ${fileId}`);

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Very large files return an HTML virus-scan interstitial instead of the
      // bytes. These are rare here; surface them clearly rather than ingest HTML.
      if (contentType.includes('text/html')) {
        throw new Error(`drive: HTML interstitial (file too large for direct download?): ${fileId}`);
      }
      // Drive serves downloads as octet-stream; the real type came from the name.
      return { externalId: doc.externalId, bytes, mimeType: doc.mimeType };
    },
  };
}
