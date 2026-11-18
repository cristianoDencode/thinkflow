import {
  prototypeAssistantRequestSchema,
  type PrototypeAssistantResultDto,
} from '@thinkflow/shared';
import type { IdGenerator } from '../../../shared/kernel/ids';
import { DomainError } from '../../../shared/kernel/errors';
import type { Toolbox } from '../../chat/application/toolbox';
import type { UsageTotals } from '../../protocol/domain/convert';
import { safeJsonParse } from '../../protocol/domain/request-translators';
import type { OAIMessage } from '../../protocol/domain/wire-types';
import { completeChat, LlmError } from '../../reports/application/llm';
import type { RouteChatRequest } from '../../routing/application/route-chat-request';
import {
  applyAnswer,
  prepareRequest,
  type AssistantInput,
  type Prepared,
} from '../domain/prototype-assistant-flow';
import {
  buildSystemPrompt,
  buildUserPrompt,
  parseAnswer,
  type ParsedAnswer,
} from '../domain/prototype-assistant-prompt';

/** Tool rounds (model asks, we answer) before the model must write the final answer. */
export const PROTOTYPE_ASSISTANT_MAX_TOOL_ROUNDS = 4;
/** Tool calls over the whole request. */
export const PROTOTYPE_ASSISTANT_MAX_TOOL_CALLS = 8;
export const PROTOTYPE_ASSISTANT_TOOL_OUTPUT_CHARS = 5_000;
const MAX_OUTPUT_TOKENS = 16_000;
const CALL_TIMEOUT_MS = 240_000;
const DEFAULT_MODEL = 'auto';
const TOOL_LIMIT_TEXT = 'Limite de consultas atingido; responda com o que já foi encontrado.';

/** What the assistant may call during one request (built by the composition root). */
export interface PrototypeAssistantTools {
  toolbox: Toolbox | null;
  /** Appended to the system prompt (library hints). */
  systemNote: string;
  /** Sources that could not be used (unknown / disabled / unreachable). */
  warnings: string[];
}

export interface PrototypeAssistantToolsPort {
  open(options: {
    libraryIds: string[];
    mcpServerIds: string[];
    maxOutputChars: number;
  }): Promise<PrototypeAssistantTools>;
}

export interface PrototypeAssistantDeps {
  router: RouteChatRequest;
  ids: IdGenerator;
  /** Throws `NotFoundError` when the prototype does not exist. */
  assertPrototype(prototypeId: string): Promise<void>;
  /** Library / MCP tools; without it the sources are ignored (with a warning). */
  tools?: PrototypeAssistantToolsPort;
  /** Drops the throw-away privacy vault of a request once it is over. */
  forgetPrivacyScope?(scope: string): void;
}

const FRIENDLY: Record<string, { status: number; message: string }> = {
  rate_limited: {
    status: 429,
    message:
      'O provedor de IA está limitando as chamadas agora. Tente de novo em instantes ou escolha outro modelo.',
  },
  quota_exhausted: {
    status: 429,
    message: 'A cota do provedor de IA acabou. Escolha outro modelo.',
  },
  capacity: {
    status: 503,
    message:
      'O provedor de IA está sobrecarregado. Tente de novo em instantes ou escolha outro modelo.',
  },
  no_connection: {
    status: 503,
    message:
      'Nenhuma conexão de IA disponível para este modelo. Confira as conexões ou escolha outro modelo.',
  },
  auth: {
    status: 502,
    message: 'O provedor de IA recusou as credenciais. Confira a conexão em Conexões.',
  },
  model_unavailable: {
    status: 502,
    message: 'O modelo escolhido não está disponível. Escolha outro modelo.',
  },
  context_length: {
    status: 413,
    message:
      'A tela é grande demais para este modelo. Selecione um componente ou escolha outro modelo.',
  },
  timeout: {
    status: 504,
    message: 'A IA demorou demais para responder. Tente de novo ou escolha outro modelo.',
  },
  privacy_error: {
    status: 500,
    message:
      'Não foi possível proteger os dados pessoais antes de enviar à IA; a requisição foi bloqueada.',
  },
};

function friendlyError(err: LlmError): DomainError {
  const known = FRIENDLY[err.reason];
  if (known)
    return new DomainError(known.message, `prototype_assistant_${err.reason}`, known.status);
  return new DomainError(
    `A IA não conseguiu responder (${err.message}). Tente de novo ou escolha outro modelo.`,
    'prototype_assistant_failed',
    502,
  );
}

const toArgs = (raw: string): Record<string, unknown> => {
  const value = safeJsonParse(raw);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n… (saída cortada)`;

function sum(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/**
 * "Assistente de IA" of the prototype editor: proposes a rewritten HTML/CSS (of the screen or of
 * the selected component); it never saves anything. Every call goes through the router, hence
 * through the privacy firewall, with a throw-away vault scope.
 */
export class PrototypeAssistant {
  constructor(private readonly deps: PrototypeAssistantDeps) {}

  async assist(
    prototypeId: string,
    rawInput: unknown,
    signal?: AbortSignal,
  ): Promise<PrototypeAssistantResultDto> {
    await this.deps.assertPrototype(prototypeId);
    const request = prototypeAssistantRequestSchema.parse(rawInput);
    const input: AssistantInput = {
      action: request.action,
      selection: request.selection,
      html: request.html,
      css: request.css,
    };
    // compaction + size limit (413) + selection lookup happen before any model call
    const prepared = prepareRequest(input);

    const warnings: string[] = [];
    let tools: PrototypeAssistantTools | null = null;
    if (request.libraryIds.length > 0 || request.mcpServerIds.length > 0) {
      if (!this.deps.tools) {
        warnings.push('As fontes (biblioteca e MCP) não estão disponíveis; respondi sem elas.');
      } else {
        tools = await this.deps.tools.open({
          libraryIds: request.libraryIds,
          mcpServerIds: request.mcpServerIds,
          maxOutputChars: PROTOTYPE_ASSISTANT_TOOL_OUTPUT_CHARS,
        });
        warnings.push(...tools.warnings);
      }
    }
    const toolbox = tools?.toolbox ?? null;

    const system =
      buildSystemPrompt({
        action: request.action,
        mode: prepared.mode,
        width: request.width,
        height: request.height,
        hasTools: toolbox !== null,
        blank: prepared.blank,
      }) + (tools?.systemNote ? `\n\n${tools.systemNote}` : '');
    const messages: OAIMessage[] = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: buildUserPrompt({
          prompt: request.prompt,
          mode: prepared.mode,
          html: prepared.send.html,
          css: prepared.send.css,
          ...(prepared.send.breadcrumb ? { breadcrumb: prepared.send.breadcrumb } : {}),
        }),
      },
    ];

    const privacyScope = `prototype-assistant:${prototypeId}:${this.deps.ids.next()}`;
    const usage: UsageTotals = { inputTokens: null, outputTokens: null };
    const model = request.model ?? DEFAULT_MODEL;
    let usedModel = model;
    const run = (msgs: OAIMessage[], withToolbox: Toolbox | null) =>
      this.converse({
        model,
        messages: msgs,
        toolbox: withToolbox,
        scope: privacyScope,
        signal,
        usage,
        warnings,
        setModel: (m) => (usedModel = m),
      });

    try {
      const final = await run(messages, toolbox);
      let outcome = this.attempt(prepared, input, final.text);
      if (!outcome.ok) {
        // one more chance, telling the model what was wrong
        const retry = await run(
          [
            ...messages,
            { role: 'assistant', content: final.text || '(vazio)' },
            {
              role: 'user',
              content: `Sua resposta anterior era inválida:\n- ${outcome.issues.slice(0, 6).join('\n- ')}\nResponda de novo SOMENTE no formato pedido (<ia-explicacao>, <ia-html>, <ia-css>).`,
            },
          ],
          null,
        );
        outcome = this.attempt(prepared, input, retry.text);
      }
      if (!outcome.ok)
        throw new DomainError(
          'A IA não devolveu uma resposta que eu consiga aplicar. Tente de novo, escolha outro modelo ou, se a tela for grande, selecione um componente.',
          'prototype_assistant_invalid_answer',
          502,
        );
      warnings.push(...outcome.warnings);
      return {
        html: outcome.html,
        css: outcome.css,
        explanation:
          outcome.explanation ||
          (prepared.mode === 'component'
            ? 'A IA atualizou o componente selecionado.'
            : 'A IA atualizou a tela.'),
        model: usedModel,
        usage,
        warnings,
      };
    } finally {
      this.deps.forgetPrivacyScope?.(privacyScope);
    }
  }

  private attempt(
    prepared: Prepared,
    input: AssistantInput,
    text: string,
  ):
    | { ok: true; html: string; css: string; warnings: string[]; explanation: string }
    | { ok: false; issues: string[] } {
    const parsed = parseAnswer(text);
    if (!parsed.ok) return parsed;
    const answer: ParsedAnswer = parsed.answer;
    const applied = applyAnswer(prepared, input, answer);
    if (!applied.ok) return applied;
    return { ...applied, explanation: answer.explanation };
  }

  /** Model rounds with tool calls until the model answers in text (or the limits are hit). */
  private async converse(options: {
    model: string;
    messages: OAIMessage[];
    toolbox: Toolbox | null;
    scope: string;
    signal: AbortSignal | undefined;
    usage: UsageTotals;
    warnings: string[];
    setModel(model: string): void;
  }): Promise<{ text: string }> {
    const { toolbox, usage } = options;
    const messages = [...options.messages];
    let toolsOn = toolbox !== null;
    let calls = 0;
    let fellBack = false;
    for (let round = 0; ; round++) {
      const withTools = toolsOn && toolbox !== null && round < PROTOTYPE_ASSISTANT_MAX_TOOL_ROUNDS;
      let result;
      try {
        result = await completeChat(
          this.deps.router,
          {
            model: options.model,
            messages,
            maxTokens: MAX_OUTPUT_TOKENS,
            temperature: 0.2,
            ...(withTools ? { tools: toolbox.defs } : {}),
          },
          {
            source: 'prototype-assistant',
            scope: options.scope,
            timeoutMs: CALL_TIMEOUT_MS,
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
      } catch (err) {
        if (!(err instanceof LlmError)) throw err;
        // a model that rejects tools: go on without the sources, once
        if (
          withTools &&
          !fellBack &&
          ['model_unavailable', 'bad_request', 'invalid_response'].includes(err.reason)
        ) {
          fellBack = true;
          toolsOn = false;
          options.warnings.push(
            'O modelo escolhido não aceitou ferramentas; respondi sem consultar as fontes.',
          );
          continue;
        }
        throw friendlyError(err);
      }
      options.setModel(result.model);
      usage.inputTokens = sum(usage.inputTokens, result.usage.inputTokens);
      usage.outputTokens = sum(usage.outputTokens, result.usage.outputTokens);

      if (result.toolCalls.length === 0 || !withTools || !toolbox) return { text: result.text };

      messages.push({
        role: 'assistant',
        content: result.text || null,
        tool_calls: result.toolCalls,
      });
      for (const call of result.toolCalls) {
        let text: string;
        if (calls >= PROTOTYPE_ASSISTANT_MAX_TOOL_CALLS) {
          text = TOOL_LIMIT_TEXT;
        } else {
          calls += 1;
          try {
            const out = await toolbox.call(
              call.function.name,
              toArgs(call.function.arguments),
              options.signal,
            );
            text = out.text;
          } catch (err) {
            if (options.signal?.aborted) throw err;
            text = err instanceof Error ? err.message : String(err);
          }
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: cut(text, PROTOTYPE_ASSISTANT_TOOL_OUTPUT_CHARS) || '(sem saída)',
        });
      }
      if (calls >= PROTOTYPE_ASSISTANT_MAX_TOOL_CALLS) toolsOn = false;
    }
  }
}
