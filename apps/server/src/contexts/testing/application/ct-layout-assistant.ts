import {
  DEFAULT_CT_LAYOUT,
  ctLayoutAssistSchema,
  type CtLayoutAssistResultDto,
} from '@thinkflow/shared';
import { DomainError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import type { OAIMessage } from '../../protocol/domain/wire-types';
import { completeChat, LlmError } from '../../reports/application/llm';
import { extractJsonObject } from '../../reports/domain/json-extract';
import type { RouteChatRequest } from '../../routing/application/route-chat-request';
import {
  buildLayoutSystemPrompt,
  buildLayoutUserPrompt,
  layoutFromJson,
  type LayoutDraft,
} from '../domain/ct-layout-prompt';
import { friendlyError } from './ct-assistant';

const MAX_OUTPUT_TOKENS = 2_000;
const CALL_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'auto';

export interface CtLayoutAssistantDeps {
  router: RouteChatRequest;
  ids: IdGenerator;
  /** Drops the throw-away privacy vault of a request once it is over. */
  forgetPrivacyScope?(scope: string): void;
}

/** "Criar modelo com IA": proposes a look for the CT document; the draft is never saved. */
export class CtLayoutAssistant {
  constructor(private readonly deps: CtLayoutAssistantDeps) {}

  async assist(input: unknown, signal?: AbortSignal): Promise<CtLayoutAssistResultDto> {
    const request = ctLayoutAssistSchema.parse(input);
    const base = request.layout ?? DEFAULT_CT_LAYOUT;
    const messages: OAIMessage[] = [
      { role: 'system', content: buildLayoutSystemPrompt() },
      { role: 'user', content: buildLayoutUserPrompt(request.prompt, request.layout) },
    ];
    // a throw-away vault, like the CT text assistant: nothing of it outlives the request
    const scope = `ct-layout-assistant:${this.deps.ids.next()}`;
    const model = request.model || DEFAULT_MODEL;
    let usedModel = model;
    const ask = async (conversation: OAIMessage[]): Promise<string> => {
      try {
        const result = await completeChat(
          this.deps.router,
          { model, messages: conversation, maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.4 },
          {
            source: 'ct-layout-assistant',
            scope,
            timeoutMs: CALL_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
          },
        );
        usedModel = result.model;
        return result.text;
      } catch (err) {
        if (err instanceof LlmError) throw friendlyError(err);
        throw err;
      }
    };

    try {
      const first = await ask(messages);
      let draft = this.parse(first, base);
      if (!draft.ok) {
        // one more chance, telling the model what was wrong
        const retry = await ask([
          ...messages,
          { role: 'assistant', content: first || '(vazio)' },
          {
            role: 'user',
            content: `Sua resposta anterior era inválida:\n- ${draft.issues.slice(0, 6).join('\n- ')}\nResponda de novo SOMENTE com o JSON corrigido.`,
          },
        ]);
        draft = this.parse(retry, base);
      }
      if (!draft.ok) {
        throw new DomainError(
          'A IA não devolveu um modelo que eu consiga aplicar. Tente de novo ou escolha outro modelo.',
          'ct_layout_invalid_answer',
          502,
        );
      }
      return {
        name: draft.name,
        layout: draft.layout,
        explanation: draft.explanation || 'Modelo proposto: revise o visual antes de salvar.',
        model: usedModel,
        warnings: [],
      };
    } finally {
      this.deps.forgetPrivacyScope?.(scope);
    }
  }

  private parse(text: string, base: typeof DEFAULT_CT_LAYOUT): LayoutDraft {
    const json = extractJsonObject(text);
    if (!json) return { ok: false, issues: ['A resposta não contém um objeto JSON.'] };
    return layoutFromJson(json, base);
  }
}
