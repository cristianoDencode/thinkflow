import type { RequestAttemptDto } from '@thinkflow/shared';
import { parseTokenLimit } from './capacity';

const compact = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Short Portuguese reason for one failed attempt, e.g. "tempo esgotado". */
export function describeAttempt(
  a: Pick<RequestAttemptDto, 'reason' | 'status' | 'message'>,
): string {
  const message = a.message ?? '';
  switch (a.reason) {
    case 'network':
      return /timeout|tempo esgotado|ocioso/i.test(message) ? 'tempo esgotado' : 'falha de rede';
    case 'context_length': {
      const parsed = parseTokenLimit(message);
      if (!parsed) return 'pedido grande demais';
      const perMinute = /per minute|\bTPM\b/i.test(message) ? '/min' : '';
      return parsed.requested
        ? `pedido grande demais: ${compact(parsed.requested)} tokens > limite ${compact(parsed.limit)}${perMinute}`
        : `pedido grande demais: limite ${compact(parsed.limit)}${perMinute}`;
    }
    case 'model_unavailable':
      if (/thought[_ ]signature/i.test(message)) return 'modelo exige assinatura de ferramenta';
      if (/real-?time|websocket|bidirectional/i.test(message))
        return 'modelo só de tempo real, sem chat';
      if (/tool/i.test(message) && /support/i.test(message))
        return 'modelo sem suporte a ferramentas';
      return 'modelo indisponível';
    case 'invalid_response': {
      const body = /\("?[^:"]*:\s*"([^"]*)"\)/.exec(message)?.[1];
      return body ? `resposta inválida: "${body}"` : 'resposta inválida';
    }
    case 'auth':
      return 'chave recusada';
    case 'rate_limited':
      return 'limite de requisições';
    case 'quota_exhausted':
      return 'cota esgotada';
    case 'capacity':
      return 'provider sobrecarregado';
    case 'server':
      return 'erro no provider';
    case 'bad_request':
      return message ? `requisição recusada: ${message.slice(0, 60)}` : 'requisição recusada';
    case 'no_available_connection':
      return 'sem conexão disponível (desativada ou em cooldown)';
    case 'unknown_provider':
      return 'provider desconhecido';
    default:
      return a.reason;
  }
}

/**
 * One entry per connection, in the order first tried (the last attempt wins, so model retries collapse), e.g.
 * `NVIDIA (tempo esgotado), Groq (pedido grande demais: 30k tokens > limite 8k/min)`.
 */
export function summarizeAttempts(
  attempts: RequestAttemptDto[],
  labelOf: (a: RequestAttemptDto) => string,
): string {
  const last = new Map<string, RequestAttemptDto>();
  for (const a of attempts) {
    if (a.reason === 'success') continue;
    const key = a.connectionId ?? `provider:${a.providerId}`;
    last.set(key, a);
  }
  // a Map keeps the order in which each connection was first tried
  const entries = [...last.values()];
  return entries.map((a) => `${labelOf(a)} (${describeAttempt(a)})`).join(', ');
}
