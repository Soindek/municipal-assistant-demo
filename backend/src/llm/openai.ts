import OpenAI from 'openai';
import { getEnv } from '../env.js';
import type { ChatClient, ChatMessage, EmbeddingClient } from './types.js';

let client: OpenAI | null = null;

/** Megosztott OpenAI kliens. A kulcs KIZÁRÓLAG env-ből (OPENAI_API_KEY). */
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  }
  return client;
}

export function createOpenAIEmbeddingClient(model: string): EmbeddingClient {
  return {
    model,
    async embed(texts, signal) {
      if (texts.length === 0) return [];
      const res = await getClient().embeddings.create({ model, input: texts }, { signal });
      // A válasz indexelt; a biztonság kedvéért index szerint rendezzük.
      return res.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    },
  };
}

export function createOpenAIChatClient(model: string): ChatClient {
  return {
    model,

    async streamChat(messages: ChatMessage[], onToken, signal) {
      const stream = await getClient().chat.completions.create(
        { model, messages, stream: true },
        { signal },
      );
      let full = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          full += delta;
          onToken(delta);
        }
      }
      return full;
    },

    async complete(messages: ChatMessage[], signal) {
      const res = await getClient().chat.completions.create(
        { model, messages, stream: false },
        { signal },
      );
      return res.choices[0]?.message?.content ?? '';
    },
  };
}
