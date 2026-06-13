import * as cheerio from 'cheerio';
import { z } from 'zod';
import type {
  DocumentSource,
  DocumentSourceContext,
  FetchedContent,
  SourceDocument,
} from '@municipal-assistant/shared';

/**
 * VARRAT #1 — `njt-onkormanyzati` adapter: a hatályos önkormányzati rendeletek
 * hiteles forrása a Nemzeti Jogszabálytárból (njt.jog.gov.hu).
 *
 * A lista- és rendeletoldalak SZERVER-RENDERELT HTML-ek (nem a blokkolt JSON-API).
 * Az adapter a "csak hatályos" szűrt listanézetet lapozza, és a rendeletoldal
 * §-tudatos szövegét nyeri ki (a magot nem terheli njt-specifikus tudással).
 *
 * Megjegyzés: a robots.txt engedi a `/jogszabaly/*`-ot; az njt rate-limitel, ezért
 * a kérések között udvarias késleltetés van. A választ idézzük + njt-re linkelünk
 * vissza (sourceUrl), nem közöljük újra teljes terjedelmében.
 */

const OptionsSchema = z.object({
  baseUrl: z.string().url().default('https://njt.jog.gov.hu'),
  /**
   * Az előszűrt lista-útszegmens, amely a kibocsátót (települést) ÉS a
   * "csak hatályos" nézetet kódolja. Pl. '-:-:-:-:1:-:-:1:-:-:2:473:-'
   * (a 473 = Vácrátót, a 2 = Pest vármegye).
   */
  listFilter: z.string().min(1),
  /** A létrehozott dokumentumok kategóriája. */
  category: z.string().default('rendeletek'),
  perPage: z.number().int().positive().max(50).default(50),
  requestTimeoutMs: z.number().int().positive().default(30000),
  /** Udvarias késleltetés a kérések között (njt rate-limit). */
  requestDelayMs: z.number().int().min(0).default(1200),
  /** Biztonsági felső korlát a lapozásra. */
  maxPages: z.number().int().positive().default(50),
  userAgent: z.string().default('municipal-assistant/0.1 (+ingestion)'),
});

export interface NjtListItem {
  /** Stabil rendelet-azonosító, pl. '2026-6-SP-5Y473'. */
  id: string;
  title: string;
  subject: string;
  /** Hatálybalépés dátuma a listából, pl. '2026. 05. 08.'. */
  effectiveDate: string | null;
  inForce: boolean;
}

/** "2026. 05. 08." → Date (UTC). Érvénytelen bemenetnél null. */
function parseHungarianDate(raw: string | null): Date | null {
  if (!raw) return null;
  const m = raw.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Kinyeri a találati tételeket és a teljes találatszámot a listaoldal HTML-jéből. */
export function parseListPage(html: string): { items: NjtListItem[]; total: number } {
  const $ = cheerio.load(html);

  const initAttr = $('[data-ng-init^="initResult"]').attr('data-ng-init') ?? '';
  const total = Number(initAttr.match(/initResult\('(\d+)'/)?.[1] ?? '0');

  const items: NjtListItem[] = [];
  $('.resultItemWrapper').each((_, el) => {
    const w = $(el);
    // A cím-link a .resultItem közvetlen gyermeke (a "K3" indokolás-ikon kívül van).
    const link = w.find('.resultItem > a[href^="jogszabaly/"]').first();
    const id = (link.attr('href') ?? '').replace(/^jogszabaly\//, '').trim();
    if (!id) return;

    const dateRaw = w.find('.resultItem .resultDate').first().text().trim();
    items.push({
      id,
      title: link.text().replace(/\s+/g, ' ').trim(),
      subject: w.find('.resultItem p.text-small').first().text().replace(/\s+/g, ' ').trim(),
      effectiveDate: dateRaw.replace(/[–-]\s*$/, '').trim() || null,
      inForce: w.find('.document_info_icon [data-njttitle]').attr('data-njttitle') === 'Hatályos',
    });
  });

  return { items, total };
}

/** §-tudatos sima szöveg a rendeletoldal HTML-jéből (cím + bekezdések sortörve). */
export function parseDecreeText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  const root = $('#jogszab');

  const title =
    root.find('h1.jogszabalyMainTitle').first().text().replace(/\s+/g, ' ').trim() ||
    $('title')
      .text()
      .replace(/\s*-\s*Nemzeti Jogszabálytár.*$/u, '')
      .trim();

  const parts: string[] = [];
  // A cím, alcím, preambulum, szakaszok (N. §) és pontok mind <h1>/<h2>/<p>-ben vannak.
  root.find('h1, h2, p').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  });

  return { title, text: parts.join('\n') };
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

export function createNjtOnkormanyzatiSource(options: Record<string, unknown>): DocumentSource {
  const opts = OptionsSchema.parse(options);

  const withTimeout = (signal: AbortSignal | undefined): AbortSignal => {
    const t = AbortSignal.timeout(opts.requestTimeoutMs);
    return signal ? AbortSignal.any([signal, t]) : t;
  };

  const getText = async (url: string, ctx: DocumentSourceContext): Promise<string> => {
    const res = await fetch(url, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'text/html' },
      signal: withTimeout(ctx.signal),
    });
    if (!res.ok) throw new Error(`njt request failed (${res.status}): ${url}`);
    return res.text();
  };

  return {
    name: 'njt-onkormanyzati',

    async *list(ctx: DocumentSourceContext): AsyncIterable<SourceDocument> {
      for (let page = 1; page <= opts.maxPages; page++) {
        const url = `${opts.baseUrl}/or/${opts.listFilter}/${page}/${opts.perPage}`;
        const html = await getText(url, ctx);
        const { items } = parseListPage(html);
        if (items.length === 0) break;

        for (const item of items) {
          if (!item.inForce) continue; // safety: only in-force decrees
          yield {
            externalId: item.id,
            title: [item.title, item.subject].filter(Boolean).join(' – '),
            category: opts.category,
            sourceUrl: `${opts.baseUrl}/jogszabaly/${item.id}`,
            mimeType: 'text/plain',
            // The effective date changes when a newer in-force version supersedes.
            changeToken: item.effectiveDate,
            publishedAt: parseHungarianDate(item.effectiveDate),
            language: 'hu',
          };
        }
        await delay(opts.requestDelayMs, ctx.signal);
      }
    },

    async fetch(doc: SourceDocument, ctx: DocumentSourceContext): Promise<FetchedContent> {
      // Polite throttle: the pipeline calls fetch() once per decree with no gap,
      // and njt rate-limits — space the downloads out.
      await delay(opts.requestDelayMs, ctx.signal);
      const html = await getText(`${opts.baseUrl}/jogszabaly/${doc.externalId}`, ctx);
      const { text } = parseDecreeText(html);
      return {
        externalId: doc.externalId,
        bytes: new TextEncoder().encode(text),
        mimeType: 'text/plain',
      };
    },
  };
}
