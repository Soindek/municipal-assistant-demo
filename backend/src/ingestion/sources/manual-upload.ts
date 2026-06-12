import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  DocumentSource,
  DocumentSourceContext,
  FetchedContent,
  SourceDocument,
} from '@municipal-assistant/shared';
import { repoRoot } from '../../paths.js';

const OptionsSchema = z.object({
  /** Helyi mappa a feldolgozandó fájlokkal (repo gyökérhez relatív). */
  dir: z.string().default('./data/uploads'),
  /** Alapértelmezett kategória, ha nincs sidecar meta. */
  defaultCategory: z.string().default('rendeletek'),
  /** Ha megadod, a sourceUrl ebből + a fájlnévből épül (különben file://). */
  baseUrl: z.string().url().optional(),
});

/** Fájlonként opcionális `<fájlnév>.meta.json` írhatja felül a metaadatot. */
const MetaSchema = z
  .object({
    title: z.string(),
    category: z.string(),
    sourceUrl: z.string(),
    publishedAt: z.string(),
  })
  .partial();

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

const META_SUFFIX = '.meta.json';

async function readMeta(metaPath: string): Promise<z.infer<typeof MetaSchema>> {
  try {
    const raw = await readFile(metaPath, 'utf8');
    return MetaSchema.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * `manual-upload` adapter — egy helyi mappából olvas. Ezzel a teljes pipeline
 * azonnal tesztelhető, valódi külső forrás nélkül (BRIEF 5./10. pont).
 */
export function createManualUploadSource(options: Record<string, unknown>): DocumentSource {
  const opts = OptionsSchema.parse(options);
  const dir = resolve(repoRoot, opts.dir);

  return {
    name: 'manual-upload',

    async *list(ctx: DocumentSourceContext): AsyncIterable<SourceDocument> {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        ctx.logger.warn(`manual-upload: a mappa nem olvasható: ${dir}`);
        return;
      }

      for (const entry of entries) {
        if (entry.endsWith(META_SUFFIX) || entry.startsWith('.')) continue;
        const ext = extname(entry).toLowerCase();
        const mimeType = MIME_BY_EXT[ext];
        if (!mimeType) {
          ctx.logger.warn(`manual-upload: kihagyva (nem támogatott típus): ${entry}`);
          continue;
        }

        const absPath = join(dir, entry);
        const info = await stat(absPath);
        const meta = await readMeta(join(dir, entry + META_SUFFIX));

        yield {
          externalId: entry,
          title: meta.title ?? basename(entry, ext),
          category: meta.category ?? opts.defaultCategory,
          sourceUrl:
            meta.sourceUrl ??
            (opts.baseUrl
              ? new URL(entry, opts.baseUrl).toString()
              : pathToFileURL(absPath).toString()),
          mimeType,
          // Olcsó változás-token: módosítási idő + méret.
          changeToken: `${Math.floor(info.mtimeMs)}:${info.size}`,
          publishedAt: meta.publishedAt ? new Date(meta.publishedAt) : info.mtime,
          language: 'hu',
          metadata: { absPath },
        };
      }
    },

    async fetch(doc: SourceDocument): Promise<FetchedContent> {
      const absPath = join(dir, doc.externalId);
      const bytes = new Uint8Array(await readFile(absPath));
      return { externalId: doc.externalId, bytes, mimeType: doc.mimeType };
    },
  };
}
