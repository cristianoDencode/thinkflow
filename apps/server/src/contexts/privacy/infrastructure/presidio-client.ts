import type { PiiKind, Span } from '../domain/pii';

export type PresidioFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Presidio / tarja-presidio entity -> our kind. Anything not listed (DATE_TIME, NRP, URL, IP...)
 * is ignored on purpose: tokenizing it would only make the text less useful to the AI.
 */
export const PRESIDIO_ENTITY_KIND: Readonly<Record<string, PiiKind>> = {
  PERSON: 'NOME',
  LOCATION: 'ENDERECO',
  ADDRESS: 'ENDERECO',
  EMAIL_ADDRESS: 'EMAIL',
  PHONE_NUMBER: 'TELEFONE',
  CREDIT_CARD: 'CARTAO',
  BR_CPF: 'CPF',
  BR_CNPJ: 'CNPJ',
  BR_CNS: 'CNS',
  BR_NIS: 'PIS',
  BR_TITULO_ELEITOR: 'TITULO',
  BR_CNH: 'CNH',
  BR_RENAVAM: 'RENAVAM',
  BR_CEP: 'CEP',
  BR_PLACA: 'PLACA',
  BR_CARTAO: 'CARTAO',
  BR_TELEFONE: 'TELEFONE',
};

const MIN_TEXT = 3;
const MAX_CHUNK = 100_000;

export interface PresidioOptions {
  /** Base URL of the analyzer (`http://presidio:3000`). */
  url: string;
  minScore: number;
  timeoutMs?: number;
  fetch?: PresidioFetch;
}

interface AnalyzeResult {
  entity_type?: unknown;
  start?: unknown;
  end?: unknown;
  score?: unknown;
}

function baseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Splits on whitespace so that no chunk exceeds `max` (a token is never cut unless it alone does). */
export function chunkText(text: string, max = MAX_CHUNK): { offset: number; text: string }[] {
  if (text.length <= max) return [{ offset: 0, text }];
  const chunks: { offset: number; text: string }[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + max, text.length);
    if (end < text.length) {
      const lastSpace = Math.max(
        text.lastIndexOf(' ', end),
        text.lastIndexOf('\n', end),
        text.lastIndexOf('\t', end),
      );
      if (lastSpace > offset) end = lastSpace + 1;
    }
    chunks.push({ offset, text: text.slice(offset, end) });
    offset = end;
  }
  return chunks;
}

/** Detector backed by the Presidio analyzer sidecar. Rejects on timeout/HTTP error (the firewall then degrades). */
export function createPresidioSpans(opts: PresidioOptions): (text: string) => Promise<Span[]> {
  const doFetch: PresidioFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 2000;
  const endpoint = `${baseUrl(opts.url)}/analyze`;

  const analyze = async (text: string, offset: number): Promise<Span[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, language: 'pt', score_threshold: opts.minScore }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`presidio HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (!Array.isArray(data)) throw new Error('presidio: resposta inesperada');
      const spans: Span[] = [];
      for (const r of data as AnalyzeResult[]) {
        const kind =
          typeof r.entity_type === 'string' ? PRESIDIO_ENTITY_KIND[r.entity_type] : undefined;
        if (!kind) continue;
        if (typeof r.start !== 'number' || typeof r.end !== 'number' || r.end <= r.start) continue;
        const score = typeof r.score === 'number' ? r.score : 0.5;
        if (score < opts.minScore) continue;
        spans.push({
          start: r.start + offset,
          end: r.end + offset,
          kind,
          score,
          source: 'presidio',
        });
      }
      return spans;
    } finally {
      clearTimeout(timer);
    }
  };

  return async (text) => {
    if (text.trim().length < MIN_TEXT) return [];
    const parts = await Promise.all(chunkText(text).map((c) => analyze(c.text, c.offset)));
    return parts.flat();
  };
}

export interface PresidioHealth {
  configured: boolean;
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}

/** `GET {url}/health` with a short timeout. Never throws; the error is a short message, no payload. */
export async function probePresidio(
  url: string,
  doFetch: PresidioFetch = (input, init) => fetch(input, init),
  timeoutMs = 2000,
): Promise<PresidioHealth> {
  if (url.trim() === '') return { configured: false, reachable: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await doFetch(`${baseUrl(url)}/health`, { signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (!res.ok)
      return { configured: true, reachable: false, latencyMs, error: `HTTP ${res.status}` };
    return { configured: true, reachable: true, latencyMs };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      configured: true,
      reachable: false,
      error: aborted ? 'Tempo esgotado' : 'Sem conexão com o Presidio',
    };
  } finally {
    clearTimeout(timer);
  }
}
