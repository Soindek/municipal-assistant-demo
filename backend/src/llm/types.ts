// Pluggable LLM and embedding interfaces. The RAG core and ingestion build
// only on these; OpenAI is wired in via backend/src/llm/openai.ts.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EmbeddingClient {
  readonly model: string;
  /** Embed multiple texts in one round; output order matches the input. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface ChatClient {
  readonly model: string;

  /**
   * Streamed response: calls `onToken` for every token fragment, and returns
   * the full text at the end.
   */
  streamChat(
    messages: ChatMessage[],
    onToken: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string>;

  /** One-shot, non-streamed response (e.g. follow-up question rewriting). */
  complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

export interface LlmClients {
  embedding: EmbeddingClient;
  chat: ChatClient;
}
