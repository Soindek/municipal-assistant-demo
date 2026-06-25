import { Injectable } from '@angular/core';
import type { AskEvent, ChatTurn } from '@municipal-assistant/shared';

/** Public tenant config served by GET /api/config (no secrets). */
export interface UiConfig {
  displayName: string;
  locale: string;
  branding: {
    assistantName: string;
    welcomeMessage: string;
    disclaimer: string;
    attribution: string | null;
    primaryColor: string | null;
    onPrimaryColor: string | null;
    logoUrl: string | null;
  };
  limits: {
    maxQuestionChars: number;
  };
}

@Injectable({ providedIn: 'root' })
export class AssistantApi {
  /** Loads tenant branding + limits for the UI. */
  async getConfig(): Promise<UiConfig> {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`Config request failed (${res.status})`);
    return (await res.json()) as UiConfig;
  }

  /** Records 👍/👎 feedback for a logged answer (referenced by its queryId). */
  async sendFeedback(queryId: string, rating: 'up' | 'down', comment?: string): Promise<void> {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queryId, rating, comment }),
    });
    if (!res.ok) throw new Error(`Feedback request failed (${res.status})`);
  }

  /**
   * Streams the answer from POST /api/ask. The endpoint returns SSE, but since
   * it is a POST we consume the body as a ReadableStream and parse `data:` frames
   * ourselves (EventSource only supports GET).
   */
  async *ask(
    question: string,
    history: ChatTurn[],
    signal?: AbortSignal,
  ): AsyncGenerator<AskEvent> {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history }),
      signal,
    });

    if (!res.ok || !res.body) {
      yield { type: 'error', message: `A szerver hibát adott (${res.status}).` };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice('data:'.length).trim();
        if (!payload) continue;
        try {
          yield JSON.parse(payload) as AskEvent;
        } catch {
          // Ignore a malformed frame and keep reading.
        }
      }
    }
  }
}
