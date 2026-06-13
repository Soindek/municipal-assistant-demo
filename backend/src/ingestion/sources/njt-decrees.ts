import * as cheerio from 'cheerio';
import { z } from 'zod';
import type {
  DocumentSource,
  DocumentSourceContext,
  FetchedContent,
  SourceDocument,
} from '@municipal-assistant/shared';
import { extractText } from '../extract.js';
import { ocrPdf } from '../ocr.js';

/**
 * SEAM #1 — `njt-decrees` adapter: the authoritative source for in-force
 * municipal decrees, from the Nemzeti Jogszabálytár (njt.jog.gov.hu).
 *
 * The list and decree pages are SERVER-RENDERED HTML (not the blocked JSON API).
 * The adapter paginates the in-force-only filtered list view and extracts the
 * §-aware decree text, so the core stays njt-agnostic.
 *
 * Note: robots.txt allows /jogszabaly/*; njt rate-limits, so requests are spaced
 * with a polite delay. We cite + link back to njt (sourceUrl), not republish.
 */

const OptionsSchema = z.object({
  baseUrl: z.string().url().default('https://njt.jog.gov.hu'),
  /**
   * The pre-filtered list path segment encoding the issuer (settlement) AND the
   * in-force-only view. E.g. '-:-:-:-:1:-:-:1:-:-:2:473:-' (473 = Vácrátót, 2 = Pest).
   */
  listFilter: z.string().min(1),
  /** Category for the produced documents. */
  category: z.string().default('rendeletek'),
  perPage: z.number().int().positive().max(50).default(50),
  requestTimeoutMs: z.number().int().positive().default(30000),
  /** Polite delay between requests (njt rate-limit). */
  requestDelayMs: z.number().int().min(0).default(1200),
  /** Safety cap on pagination. */
  maxPages: z.number().int().positive().default(50),
  userAgent: z.string().default('municipal-assistant/0.1 (+ingestion)'),

  /** Whether to download the decree's attachment PDFs (fee tables, budgets). */
  includeAttachments: z.boolean().default(true),
  /** OCR scanned attachment PDFs (slow, Hungarian). */
  ocrAttachments: z.boolean().default(true),
  /** Cap on the number of attachments per document. */
  maxAttachmentsPerDoc: z.number().int().min(0).default(20),
  /** Attachment OCR parameters (kept in line with the main OCR). */
  ocrViewportScale: z.number().positive().default(3),
  ocrMaxPages: z.number().int().min(0).default(15),
});

export interface NjtListItem {
  /** Stable decree id, e.g. '2026-6-SP-5Y473'. */
  id: string;
  title: string;
  subject: string;
  /** Effective date from the list, e.g. '2026. 05. 08.'. */
  effectiveDate: string | null;
  inForce: boolean;
}

/** "2026. 05. 08." → Date (UTC). Returns null on invalid input. */
function parseEffectiveDate(raw: string | null): Date | null {
  if (!raw) return null;
  const m = raw.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Extracts the result items and the total hit count from the list page HTML. */
export function parseListPage(html: string): { items: NjtListItem[]; total: number } {
  const $ = cheerio.load(html);

  const initAttr = $('[data-ng-init^="initResult"]').attr('data-ng-init') ?? '';
  const total = Number(initAttr.match(/initResult\('(\d+)'/)?.[1] ?? '0');

  const items: NjtListItem[] = [];
  $('.resultItemWrapper').each((_, el) => {
    const w = $(el);
    // The decree (title) link — any jogszabaly link except the "K3" justification
    // icon (.document_justification_icon). Robust to type-code variations.
    const link = w.find('a[href^="jogszabaly/"]').not('.document_justification_icon').first();
    const id = (link.attr('href') ?? '').replace(/^jogszabaly\//, '').trim();
    if (!id) return;

    const dateRaw = w.find('.resultDate').first().text().trim();
    const statusTitle = w.find('.document_info_icon [data-njttitle]').attr('data-njttitle') ?? '';
    items.push({
      id,
      title: link.text().replace(/\s+/g, ' ').trim(),
      subject: w.find('p.text-small').first().text().replace(/\s+/g, ' ').trim(),
      effectiveDate: dateRaw.replace(/[–-]\s*$/, '').trim() || null,
      // Trust the in-force-only view: include unless explicitly out of force.
      inForce: !/hatályon kívül|hatálytalan/iu.test(statusTitle),
    });
  });

  return { items, total };
}

export interface DecreeAttachment {
  label: string;
  /** Relative or absolute PDF URL (e.g. '/document/.../attachment.pdf'). */
  url: string;
}

/** §-aware plain text + attachment PDF links from the decree page HTML. */
export function parseDecreeText(html: string): {
  title: string;
  text: string;
  attachments: DecreeAttachment[];
} {
  const $ = cheerio.load(html);
  const root = $('#jogszab');

  const title =
    root.find('h1.jogszabalyMainTitle').first().text().replace(/\s+/g, ' ').trim() ||
    $('title')
      .text()
      .replace(/\s*-\s*Nemzeti Jogszabálytár.*$/u, '')
      .trim();

  const parts: string[] = [];
  // The title, subtitle, preamble, sections (N. §) and points are all in <h1>/<h2>/<p>.
  root.find('h1, h2, p').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  });

  // Attachment PDF links (the tables/figures live here, not in the HTML body).
  const attachments: DecreeAttachment[] = [];
  const seen = new Set<string>();
  root.find('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!/\.pdf($|\?)/i.test(href) || seen.has(href)) return;
    seen.add(href);
    attachments.push({ label: $(el).text().replace(/\s+/g, ' ').trim() || href, url: href });
  });

  return { title, text: parts.join('\n'), attachments };
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

export function createNjtDecreesSource(options: Record<string, unknown>): DocumentSource {
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

  const getBytes = async (url: string, ctx: DocumentSourceContext): Promise<Uint8Array> => {
    const res = await fetch(url, {
      headers: { 'User-Agent': opts.userAgent },
      signal: withTimeout(ctx.signal),
    });
    if (!res.ok) throw new Error(`njt attachment failed (${res.status}): ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  };

  /** Downloads + extracts an attachment PDF (OCR fallback for scanned ones). */
  const extractAttachment = async (url: string, ctx: DocumentSourceContext): Promise<string> => {
    await delay(opts.requestDelayMs, ctx.signal);
    const bytes = await getBytes(url, ctx);
    const extracted = await extractText({
      externalId: url,
      bytes,
      mimeType: 'application/pdf',
    });
    if (!extracted.likelyScanned) {
      return extracted.pages.map((p) => p.text).join('\n');
    }
    if (!opts.ocrAttachments) return '';
    const pages = await ocrPdf(bytes, {
      viewportScale: opts.ocrViewportScale,
      maxPages: opts.ocrMaxPages,
    });
    return pages.map((p) => p.text).join('\n');
  };

  return {
    name: 'njt-decrees',

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
            publishedAt: parseEffectiveDate(item.effectiveDate),
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
      const { text, attachments } = parseDecreeText(html);

      const sections = [text];
      if (opts.includeAttachments) {
        const list = attachments.slice(0, opts.maxAttachmentsPerDoc);
        for (const att of list) {
          const absUrl = att.url.startsWith('http') ? att.url : `${opts.baseUrl}${att.url}`;
          try {
            const attText = await extractAttachment(absUrl, ctx);
            if (attText.trim()) sections.push(`\n=== ${att.label} ===\n${attText}`);
          } catch (err) {
            ctx.logger.warn(`njt attachment skipped (${att.label}): ${(err as Error).message}`);
          }
        }
      }

      return {
        externalId: doc.externalId,
        bytes: new TextEncoder().encode(sections.join('\n')),
        mimeType: 'text/plain',
      };
    },
  };
}
