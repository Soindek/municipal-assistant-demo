// Csereszabatos LLM- és embedding-interfészek. A RAG-mag és az ingestion
// csak ezekre épül; az OpenAI a backend/src/llm/openai.ts-ben van bekötve.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EmbeddingClient {
  readonly model: string;
  /** Több szöveg beágyazása egy körben; a kimenet sorrendje a bemenettel egyezik. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface ChatClient {
  readonly model: string;

  /**
   * Streamelt válasz: minden token-darabra meghívja `onToken`-t, és a végén
   * visszaadja a teljes szöveget.
   */
  streamChat(
    messages: ChatMessage[],
    onToken: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string>;

  /** Egylövéses, nem streamelt válasz (pl. követő-kérdés átírása). */
  complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

export interface LlmClients {
  embedding: EmbeddingClient;
  chat: ChatClient;
}
