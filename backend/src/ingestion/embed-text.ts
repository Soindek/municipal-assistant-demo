/**
 * The text fed to the embedding model for a chunk: the document title as
 * context, then the chunk body. Including the title makes title-only signals
 * (dates, document type) discoverable by semantic search, without changing the
 * stored/cited chunk content. (Contextual-retrieval technique.)
 */
export function buildEmbedText(title: string, content: string): string {
  return `${title}\n\n${content}`;
}
