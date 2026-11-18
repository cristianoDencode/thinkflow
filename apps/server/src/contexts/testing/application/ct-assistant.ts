import {
  CT_ASSISTANT_ACTION_LABELS,
  ctAssistantPatchSchema,
  ctAssistantRequestSchema,
  type CtAssistantResultDto,
} from '@thinkflow/shared';
import type { IdGenerator } from '../../../shared/kernel/ids';
import { DomainError } from '../../../shared/kernel/errors';
import type { Toolbox } from '../../chat/application/toolbox';
import type { UsageTotals } from '../../protocol/domain/convert';
import { safeJsonParse } from '../../protocol/domain/request-translators';
import type { OAIMessage } from '../../protocol/domain/wire-types';
import { extractJsonObject } from '../../reports/domain/json-extract';
import { completeChat, LlmError } from '../../reports/application/llm';
import type { RouteChatRequest } from '../../routing/application/route-chat-request';
import {
  answerFromJson,
  buildSystemPrompt,
  buildUserPrompt,
  CT_ASSISTANT_MAX_DOCUMENT_CHARS,
  isEmptyPatch,
  renderDocumentForModel,
  resolveTargets,
  sanitizePatch,
} from '../domain/ct-assistant-prompt';

/** Tool rounds (model asks, we answer) before the model must write the final JSON. */
export const CT_ASSISTANT_MAX_TOOL_ROUNDS = 5;
/** Tool calls over the whole request (library tools also enforce their own per-turn limits). */
export const CT_ASSISTANT_MAX_TOOL_CALLS = 10;
export const CT_ASSISTANT_TOOL_OUTPUT_CHARS = 6_000;
const MAX_OUTPUT_TOKENS = 6_000;
const CALL_TIMEOUT_MS = 180_000;
const toArgs = (raw: string): Record<string, unknown> => {
  const value = safeJsonParse(raw);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const DEFAULT_MODEL = 'auto';
const TOOL_LIMIT_TEXT = 'Limite de consultas atingido; responda com o que já foi encontrado.';

/** What the assistant may call during one request (built by the composition root). */
export interface CtAssistantTools {
  toolbox: Toolbox | null;
  /** Appended to the system prompt (library hints). */
  systemNote: string;
  /** Sources that could not be used (unknown / disabled / unreachable). */
  warnings: string[];
}

export interface CtAssistantToolsPort {
  open(options: {
    libraryIds: string[];
    mcpServerIds: string[];
    maxOutputChars: number;
  }): Promise<CtAssistantTools>;
}

export interface CtAssistantDeps {
  router: RouteChatRequest;
  ids: IdGenerator;
  /** Throws `NotFoundError` when the session does not exist. */
  assertSession(sessionId: string): Promise<void>;
  /** Library / MCP tools; without it the sources are ignored (with a warning). */
  tools?: CtAssistantToolsPort;
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
    message: 'O trecho é grande demais para este modelo. Escolha um escopo menor ou outro modelo.',
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

export function friendlyError(err: LlmError): DomainError {
  const known = FRIENDLY[err.reason];
  if (known) return new DomainError(known.message, `ct_assistant_${err.reason}`, known.status);
  return new DomainError(
    `A IA não conseguiu responder (${err.message}). Tente de novo ou escolha outro modelo.`,
    'ct_assistant_failed',
    502,
  );
}

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n… (saída cortada)`;

/** "Assistente de IA" of the CT document: proposes a text patch; it never changes the document. */
export class CtAssistant {
  constructor(private readonly deps: CtAssistantDeps) {}

  async assist(
    sessionId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CtAssistantResultDto> {
    await this.deps.assertSession(sessionId);
    const request = ctAssistantRequestSchema.parse(input);
    if (request.action === 'custom' && !request.prompt)
      throw new DomainError('Escreva o que você quer pedir à IA.', 'ct_assistant_prompt', 400);

    const doc = request.document;
    const resolved = resolveTargets(request.action, request.scope, doc);
    if (!resolved.ok) throw new DomainError(resolved.message, 'ct_assistant_scope', 400);
    const { targets } = resolved;
    if (
      request.action !== 'suggest_title' &&
      !targets.title &&
      !targets.analysisTitle &&
      !targets.context &&
      targets.useCases.length === 0
    )
      throw new DomainError(
        'Não há texto para a IA trabalhar neste escopo.',
        'ct_assistant_scope',
        400,
      );

    const documentText = renderDocumentForModel(doc, request.scope, targets);
    if (documentText.length > CT_ASSISTANT_MAX_DOCUMENT_CHARS)
      throw new DomainError(
        'O trecho escolhido é grande demais para a IA. Escolha um escopo menor (Contexto ou um caso de uso).',
        'ct_assistant_too_large',
        413,
      );

    const warnings: string[] = [];
    let tools: CtAssistantTools | null = null;
    const wantsSources = request.libraryIds.length > 0 || request.mcpServerIds.length > 0;
    if (wantsSources) {
      if (!this.deps.tools) {
        warnings.push('As fontes (biblioteca e MCP) não estão disponíveis; respondi sem elas.');
      } else {
        tools = await this.deps.tools.open({
          libraryIds: request.libraryIds,
          mcpServerIds: request.mcpServerIds,
          maxOutputChars: CT_ASSISTANT_TOOL_OUTPUT_CHARS,
        });
        warnings.push(...tools.warnings);
      }
    }
    const toolbox = tools?.toolbox ?? null;

    const system =
      buildSystemPrompt(request.action, targets, toolbox !== null) +
      (tools?.systemNote ? `\n\n${tools.systemNote}` : '');
    const messages: OAIMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: buildUserPrompt(request.action, request.prompt, documentText) },
    ];

    // a throw-away vault: the same real value keeps the same token across the tool rounds of
    // this request, and nothing of it outlives the request
    const privacyScope = `ct-assistant:${sessionId}:${this.deps.ids.next()}`;
    const usage: UsageTotals = { inputTokens: null, outputTokens: null };
    const model = request.model ?? DEFAULT_MODEL;
    let usedModel = model;
    try {
      const final = await this.converse({
        model,
        messages,
        toolbox,
        scope: privacyScope,
        signal,
        usage,
        warnings,
        setModel: (m) => (usedModel = m),
      });

      let answer = this.tryParse(final.text);
      if (!answer.ok) {
        // one more chance, telling the model what was wrong
        const retry = await this.converse({
          model,
          messages: [
            ...messages,
            { role: 'assistant', content: final.text || '(vazio)' },
            {
              role: 'user',
              content: `Sua resposta anterior era inválida:\n- ${answer.issues.slice(0, 6).join('\n- ')}\nResponda de novo SOMENTE com o JSON corrigido.`,
            },
          ],
          toolbox: null,
          scope: privacyScope,
          signal,
          usage,
          warnings,
          setModel: (m) => (usedModel = m),
        });
        answer = this.tryParse(retry.text);
      }
      if (!answer.ok)
        throw new DomainError(
          'A IA não devolveu uma resposta que eu consiga aplicar. Tente de novo ou escolha outro modelo.',
          'ct_assistant_invalid_answer',
          502,
        );

      const clean = sanitizePatch(answer.patch, doc, targets);
      warnings.push(...clean.warnings);
      const explanation =
        answer.explanation ||
        (isEmptyPatch(clean.patch)
          ? 'A IA não sugeriu alterações.'
          : `${CT_ASSISTANT_ACTION_LABELS[request.action]}: veja as mudanças sugeridas.`);
      return { patch: clean.patch, explanation, model: usedModel, usage, warnings };
    } finally {
      this.deps.forgetPrivacyScope?.(privacyScope);
    }
  }

  private tryParse(
    text: string,
  ):
    | { ok: true; patch: ReturnType<typeof ctAssistantPatchSchema.parse>; explanation: string }
    | { ok: false; issues: string[] } {
    const json = extractJsonObject(text);
    if (!json) return { ok: false, issues: ['A resposta não contém um objeto JSON.'] };
    const { explanation, candidate } = answerFromJson(json);
    const parsed = ctAssistantPatchSchema.safeParse(candidate);
    if (!parsed.success)
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'resposta'}: ${i.message}`),
      };
    return { ok: true, patch: parsed.data, explanation };
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
      const withTools = toolsOn && toolbox !== null && round < CT_ASSISTANT_MAX_TOOL_ROUNDS;
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
            source: 'ct-assistant',
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
        if (calls >= CT_ASSISTANT_MAX_TOOL_CALLS) {
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
          content: cut(text, CT_ASSISTANT_TOOL_OUTPUT_CHARS) || '(sem saída)',
        });
      }
      if (calls >= CT_ASSISTANT_MAX_TOOL_CALLS) toolsOn = false;
    }
  }
}

function sum(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}
