import { closePool } from './pool.js';
import { listRecentQueryLog } from './repositories/query-log.js';

/**
 * Review/export tool: dumps the most recent query_log rows as CSV to stdout, for
 * manual quality review (question / answer / feedback). On the server:
 *
 *   docker compose -f docker-compose.prod.yml run --rm backend npm run querylog > querylog.csv
 *
 * Optional first arg = row limit (default 500). Open the CSV in Excel/Sheets and
 * label correctness; the feedback column already holds 👍 (1) / 👎 (−1).
 */
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** "Title, 12. § (3. o.) — https://… | Title2 — https://…" */
function formatSources(sources: { documentTitle: string; sectionRef?: string; pageNumber?: number; sourceUrl: string }[]): string {
  return sources
    .map((s) => {
      let label = s.documentTitle;
      if (s.sectionRef) label += `, ${s.sectionRef}`;
      if (s.pageNumber) label += ` (${s.pageNumber}. o.)`;
      return `${label} — ${s.sourceUrl}`;
    })
    .join(' | ');
}

async function main(): Promise<void> {
  const limit = Math.min(Math.max(Number(process.argv[2]) || 500, 1), 5000);
  const rows = await listRecentQueryLog(limit);

  const headers = [
    'id',
    'created_at',
    'question',
    'rewritten_query',
    'answer',
    'feedback',
    'feedback_comment',
    'cited_sources',
    'retrieved_docs',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.createdAt.toISOString(),
        r.question,
        r.rewrittenQuery,
        r.answer,
        r.feedback,
        r.feedbackComment,
        formatSources(r.sources), // what the answer cited (the "Források")
        r.retrievedDocTitles.join(' | '), // what was in the rerank context (diagnostic)
      ]
        .map(csvField)
        .join(','),
    );
  }

  // BOM + CRLF so Excel opens the UTF-8 (Hungarian) content correctly.
  const bom = String.fromCharCode(0xfeff);
  process.stdout.write(bom + lines.join('\r\n') + '\r\n');
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
