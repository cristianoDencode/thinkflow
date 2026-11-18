import type { ChatMessageDto, ChatStreamEvent } from '@thinkflow/shared';
import type { UiMessage } from './types';

/** `<gerar_documento>` directives (also unfinished ones) are for the server, never for the reader. */
const DIRECTIVE = /<gerar_documento>[\s\S]*?(?:<\/gerar_documento>|$)/gi;

export function hideDirective(text: string): string {
  return text.includes('<gerar_documento') ? text.replace(DIRECTIVE, '').trimEnd() : text;
}

/** Applies one streamed event to the assistant message being generated. */
export function applyStreamEvent(message: UiMessage, event: ChatStreamEvent): UiMessage {
  switch (event.type) {
    case 'step':
      return {
        ...message,
        steps: {
          ...(message.steps ?? { analyze: 'pending', search: 'pending', compose: 'pending' }),
          [event.step]: event.status,
        },
      };
    case 'delta':
      return { ...message, content: hideDirective(message.content + event.text) };
    case 'report':
      return { ...message, report: { id: event.reportId, title: event.title, kind: event.kind } };
    case 'query_result':
      return {
        ...message,
        queryResults: [
          ...(message.queryResults ?? []).filter((r) => r.id !== event.result.id),
          event.result,
        ],
      };
    case 'sql_validation':
      return { ...message, sqlValidation: event.blocks };
    case 'answer_rewrite':
      // the model is rewriting its last draft: the earlier SQL checks no longer apply
      return { ...message, content: message.content.slice(0, event.keepChars), sqlValidation: [] };
    case 'ai_review':
      return {
        ...message,
        reviews: [
          ...(message.reviews ?? []).filter((r) => r.review.reviewId !== event.review.reviewId),
          { review: event.review },
        ],
      };
    case 'ai_review_closed':
      return {
        ...message,
        reviews: (message.reviews ?? []).map((r) =>
          r.review.reviewId === event.reviewId ? { ...r, closed: event.reason } : r,
        ),
      };
    case 'reasoning':
      return { ...message, reasoning: (message.reasoning ?? '') + event.text };
    case 'tool_call':
      return {
        ...message,
        toolCalls: [...message.toolCalls, { id: event.id, name: event.name, input: event.input }],
      };
    case 'tool_result':
      return {
        ...message,
        toolCalls: message.toolCalls.map((t) =>
          t.id === event.id ? { ...t, output: event.output, isError: event.isError } : t,
        ),
      };
    case 'context':
      return {
        ...message,
        context: {
          keptMessages: event.keptMessages,
          omittedMessages: event.omittedMessages,
          summarized: event.summarized,
          estimatedTokens: event.estimatedTokens,
          budgetTokens: event.budgetTokens,
        },
      };
    case 'error':
      return { ...message, error: event.message };
    case 'done':
      return {
        ...message,
        id: event.messageId,
        streaming: false,
        providerId: event.providerId ?? null,
        model: event.model ?? null,
        inputTokens: event.inputTokens ?? null,
        outputTokens: event.outputTokens ?? null,
        costUsd: event.costUsd ?? null,
      };
    default:
      return message;
  }
}

export function fromDto(dto: ChatMessageDto): UiMessage {
  const failed = dto.role === 'assistant' && dto.content.startsWith('⚠️');
  return {
    id: dto.id,
    role: dto.role,
    content: failed ? '' : dto.content,
    ...(failed ? { error: dto.content.replace(/^⚠️\s*/, '') } : {}),
    toolCalls: dto.meta.toolCalls ?? [],
    providerId: dto.meta.providerId ?? null,
    model: dto.meta.model ?? null,
    feedback: dto.meta.feedback ?? null,
    ...(dto.meta.attachments ? { attachments: dto.meta.attachments } : {}),
    ...(dto.meta.carried ? { carried: true } : {}),
    ...(dto.meta.library ? { library: dto.meta.library } : {}),
    ...(dto.meta.report ? { report: dto.meta.report } : {}),
    ...(dto.meta.sqlValidation?.length ? { sqlValidation: dto.meta.sqlValidation } : {}),
    ...(dto.meta.diagramRepairs ? { diagramRepairs: dto.meta.diagramRepairs } : {}),
    ...(dto.meta.queryResults?.length
      ? {
          queryResults: dto.meta.queryResults,
          // a typed query has no model text: it renders as a lone result card
          ...(dto.role === 'assistant' &&
          !dto.content &&
          dto.meta.queryResults.every((r) => r.source === 'direct')
            ? { direct: true }
            : {}),
        }
      : {}),
    ...(dto.role === 'assistant'
      ? {
          steps: {
            analyze: 'done',
            search: dto.meta.toolCalls?.length ? 'done' : 'skipped',
            compose: 'done',
          } as const,
        }
      : {}),
  };
}
