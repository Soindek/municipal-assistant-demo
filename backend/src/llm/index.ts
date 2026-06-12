import type { TenantConfig } from '@municipal-assistant/shared';
import { createOpenAIChatClient, createOpenAIEmbeddingClient } from './openai.js';
import type { LlmClients } from './types.js';

export type { ChatClient, ChatMessage, EmbeddingClient, LlmClients } from './types.js';

/**
 * A tenant config által megnevezett modellekből épít LLM-klienseket.
 * Jelenleg OpenAI; más providert ide bekötve, a config modellnevét értelmezve
 * lehet hozzáadni — a hívó kód nem változik.
 */
export function createLlmClients(config: TenantConfig): LlmClients {
  return {
    embedding: createOpenAIEmbeddingClient(config.rag.embeddingModel),
    chat: createOpenAIChatClient(config.rag.chatModel),
  };
}
