// ──────────────────── shared/src/document-source.ts ──────────────────
// SEAM #1 types. Every subsequent pipeline step builds on these and does not
// know where the data came from.

/** Descriptor of a raw source document, before processing. */
export interface SourceDocument {
  /**
   * Stable key, unique within the source (e.g. file URL or Drive fileId).
   * Deduplication and change tracking key off this (documents.external_id).
   */
  externalId: string;

  title: string;

  /** One of the TenantConfig.categories keys (e.g. "rendeletek"). */
  category: string;

  /** Where the user can access the original (for source citation). */
  sourceUrl: string;

  /** e.g. "application/pdf" */
  mimeType: string;

  /**
   * Change-tracking token: lets us cheaply decide whether reprocessing is
   * needed. Can be anything (ETag, Last-Modified, size, content hash). If null,
   * always reprocess (e.g. when the source provides no reliable signal).
   */
  changeToken: string | null;

  /** If extractable from the source. */
  publishedAt?: Date | null;

  /** Defaults to the tenant locale. */
  language?: string;

  /** Adapter-specific extra (the core need not understand it). */
  metadata?: Record<string, unknown>;
}

/** A document's downloaded binary content. */
export interface FetchedContent {
  externalId: string;
  bytes: Uint8Array;
  mimeType: string;
}

/** Minimal injected logger (the concrete implementation is provided by the backend). */
export interface SourceLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** Runtime context for the adapter. */
export interface DocumentSourceContext {
  tenantId: string;
  logger: SourceLogger;
  /** For cancellation (timeout, shutdown). */
  signal?: AbortSignal;
}

/**
 * SEAM #1 — the only deeply municipality-specific part of ingestion.
 *
 * An adapter is responsible for two things:
 *  - list(): discovery (listing + metadata + change token),
 *  - fetch(): downloading the binary of a specific document.
 *
 * Every subsequent pipeline step (PDF/OCR, chunking, embedding, upsert) is
 * GENERIC and does not know where the data came from.
 */
export interface DocumentSource {
  /** Human-readable name, for logging/diagnostics (e.g. "wordpress-accordion"). */
  readonly name: string;

  /**
   * Lists the available documents.
   * AsyncIterable so it can be paginated/streamed and we don't have to hold
   * everything in memory at once.
   */
  list(ctx: DocumentSourceContext): AsyncIterable<SourceDocument>;

  /**
   * Downloads the content of a specific document.
   * A separate step because some sources (e.g. Google Drive, authenticated APIs)
   * require their own downloader — a plain HTTP GET on sourceUrl is not enough.
   */
  fetch(doc: SourceDocument, ctx: DocumentSourceContext): Promise<FetchedContent>;
}

/**
 * Adapter factory: the registry maps the TenantConfig.sources[].adapter name to
 * this and instantiates it with the options. Each adapter narrows/validates the
 * options type (e.g. with zod).
 */
export type DocumentSourceFactory = (options: Record<string, unknown>) => DocumentSource;
