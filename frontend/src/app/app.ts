import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type WritableSignal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ChatTurn, Source } from '@municipal-assistant/shared';
import { AssistantApi, type UiConfig } from './api';

/** Removes inline "[Forrás N]" / "[Forrás 1, 2]" markers and tidies spacing. */
function stripInlineCitations(text: string): string {
  return text
    .replace(/\s*\[\s*Forrás\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

/** One rendered chat message. Per-message signals so token updates are cheap. */
interface UiMessage {
  role: 'user' | 'assistant';
  text: WritableSignal<string>;
  sources: WritableSignal<Source[]>;
  pending: WritableSignal<boolean>;
  error: WritableSignal<string | null>;
}

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly api = inject(AssistantApi);

  protected readonly config = signal<UiConfig | null>(null);
  protected readonly messages = signal<UiMessage[]>([]);
  protected readonly draft = signal('');
  protected readonly sending = signal(false);
  protected readonly configError = signal<string | null>(null);

  protected readonly maxChars = computed(() => this.config()?.limits.maxQuestionChars ?? 1000);
  protected readonly remaining = computed(() => this.maxChars() - this.draft().length);
  protected readonly canSend = computed(() => {
    const q = this.draft().trim();
    return !this.sending() && q.length > 0 && this.draft().length <= this.maxChars();
  });

  constructor() {
    void this.loadConfig();
    this.setupIframeAutoHeight();
  }

  private async loadConfig(): Promise<void> {
    try {
      this.config.set(await this.api.getConfig());
    } catch {
      this.configError.set('Nem sikerült betölteni a beállításokat. Fut a háttérszolgáltatás?');
    }
  }

  /** Reports document height to the embedding page so the iframe can auto-size. */
  private setupIframeAutoHeight(): void {
    afterNextRender(() => {
      const post = () => {
        const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
        window.parent?.postMessage({ type: 'municipal-assistant:resize', height }, '*');
      };
      new ResizeObserver(post).observe(document.documentElement);
      post();
    });
  }

  protected onKeydown(event: KeyboardEvent): void {
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.send();
    }
  }

  protected async send(): Promise<void> {
    if (!this.canSend()) return;
    const question = this.draft().trim();

    // Snapshot the conversation so far as history (completed turns only).
    const history: ChatTurn[] = this.messages().map((m) => ({
      role: m.role,
      content: m.text(),
    }));

    this.messages.update((list) => [...list, this.makeMessage('user', question)]);
    this.draft.set('');

    const assistant = this.makeMessage('assistant', '');
    assistant.pending.set(true);
    this.messages.update((list) => [...list, assistant]);

    this.sending.set(true);

    try {
      for await (const ev of this.api.ask(question, history)) {
        if (ev.type === 'token') {
          assistant.text.update((t) => t + ev.text);
        } else if (ev.type === 'sources') {
          assistant.sources.set(ev.sources);
        } else if (ev.type === 'error') {
          assistant.error.set(ev.message);
        } else if (ev.type === 'done') {
          break;
        }
      }
    } catch {
      assistant.error.set('Megszakadt a kapcsolat a szerverrel.');
    } finally {
      // Safety net: the prompt tells the model not to print inline [Forrás N]
      // markers (sources are shown separately), but strip any stragglers.
      assistant.text.set(stripInlineCitations(assistant.text()));
      assistant.pending.set(false);
      this.sending.set(false);
    }
  }

  private makeMessage(role: 'user' | 'assistant', text: string): UiMessage {
    return {
      role,
      text: signal(text),
      sources: signal<Source[]>([]),
      pending: signal(false),
      error: signal<string | null>(null),
    };
  }
}
