// ──────────────────── shared/src/document-source.ts ──────────────────
// VARRAT #1 típusai. A pipeline minden további lépése ezekre épül, és nem
// tudja, honnan jött az adat.

/** Egy nyers forrásdokumentum leírója, még feldolgozás előtt. */
export interface SourceDocument {
  /**
   * Stabil, a forráson belül egyedi kulcs (pl. fájl-URL vagy Drive fileId).
   * Erre köt a deduplikáció és a változásfigyelés (documents.external_id).
   */
  externalId: string;

  title: string;

  /** A TenantConfig.categories egyik kulcsa (pl. "rendeletek"). */
  category: string;

  /** Ahonnan a felhasználó elérheti az eredetit (forrásmegjelöléshez). */
  sourceUrl: string;

  /** pl. "application/pdf" */
  mimeType: string;

  /**
   * Változásfigyelő token: amivel olcsón eldönthető, kell-e újra feldolgozni.
   * Bármi lehet (ETag, Last-Modified, méret, tartalom-hash). Ha null, mindig
   * újrafeldolgozandó (pl. ha a forrás nem ad megbízható jelet).
   */
  changeToken: string | null;

  /** Ha kinyerhető a forrásból. */
  publishedAt?: Date | null;

  /** Alapértelmezés a tenant locale-ja. */
  language?: string;

  /** Adapter-specifikus extra (a magnak nem kell értenie). */
  metadata?: Record<string, unknown>;
}

/** Egy dokumentum letöltött bináris tartalma. */
export interface FetchedContent {
  externalId: string;
  bytes: Uint8Array;
  mimeType: string;
}

/** Minimális, injektált logger (a konkrét implementációt a backend adja). */
export interface SourceLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** Futásidejű kontextus az adapternek. */
export interface DocumentSourceContext {
  tenantId: string;
  logger: SourceLogger;
  /** Megszakításhoz (időtúllépés, leállítás). */
  signal?: AbortSignal;
}

/**
 * VARRAT #1 — az egyetlen mélyen településspecifikus rész a betöltésben.
 *
 * Egy adapter két dologért felel:
 *  - list(): felfedezés (listázás + metaadat + változás-token),
 *  - fetch(): egy konkrét dokumentum bináris letöltése.
 *
 * A pipeline minden további lépése (PDF/OCR, darabolás, embedding, upsert)
 * ÁLTALÁNOS, és nem tudja, honnan jött az adat.
 */
export interface DocumentSource {
  /** Emberi név, logoláshoz/diagnosztikához (pl. "wordpress-accordion"). */
  readonly name: string;

  /**
   * Felsorolja az elérhető dokumentumokat.
   * AsyncIterable, hogy lapozható/streamelhető legyen, és ne kelljen mindent
   * egyszerre memóriában tartani.
   */
  list(ctx: DocumentSourceContext): AsyncIterable<SourceDocument>;

  /**
   * Letölti egy konkrét dokumentum tartalmát.
   * Külön lépés, mert egyes források (pl. Google Drive, hitelesített API-k)
   * saját letöltőt igényelnek — nem elég egy sima HTTP GET a sourceUrl-re.
   */
  fetch(doc: SourceDocument, ctx: DocumentSourceContext): Promise<FetchedContent>;
}

/**
 * Adapter-gyár: a registry a TenantConfig.sources[].adapter névhez ezt rendeli,
 * és az options-szal példányosítja. Az options típusát az egyes adapterek
 * szűkítik/validálják (pl. zod-dal).
 */
export type DocumentSourceFactory = (options: Record<string, unknown>) => DocumentSource;
