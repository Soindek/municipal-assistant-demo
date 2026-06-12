import type { TenantConfig } from '@municipal-assistant/shared';
import { createOpenAIChatClient, createOpenAIEmbeddingClient } from './openai.js';
import type { LlmClients } from './types.js';

export type { ChatClient, ChatMessage, EmbeddingClient, LlmClients } from './types.js';

/**
 * Builds LLM clients from the models named in the tenant config.
 * Currently OpenAI; another provider can be added by wiring it in here and
 * interpreting the config's model name — the calling code does not change.
 */
export function createLlmClients(config: TenantConfig): LlmClients {
  return {
    embedding: createOpenAIEmbeddingClient(config.rag.embeddingModel),
    chat: createOpenAIChatClient(config.rag.chatModel),
  };
}
