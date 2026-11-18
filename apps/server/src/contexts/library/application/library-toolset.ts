import type { LibraryEngine, LibraryToolResult } from '../domain/engine';
import type { Library, LibraryDocument } from '../domain/library';
import {
  DEFAULT_TOP_K,
  LIBRARY_TOOL_MAX_CALLS_PER_TURN,
  LIBRARY_TOOL_MAX_CHARS,
  LIBRARY_TOOL_MAX_TOTAL_CHARS_PER_TURN,
  LIBRARY_TOOL_NAME,
  LIBRARY_TURN_LIMIT_TEXT,
  MAX_TOP_K,
  systemNote,
  toolDefinition,
  type LibraryToolDef,
} from '../domain/tool-format';

/** Smallest output budget worth spending a call on. */
const MIN_USEFUL_CHARS = 200;
const MAX_QUERY_CHARS = 500;

/** Structurally compatible with the chat context's `LibraryChatTools` port. */
export interface LibraryChatTools {
  libraryId: string;
  libraryName: string;
  systemNote: string;
  tools: LibraryToolDef[];
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }>;
}

export interface LibraryToolsDeps {
  library: Library;
  documents: LibraryDocument[];
  engine: LibraryEngine;
  /** Upper bound for one call's output (the caller derives it from the context budget). */
  maxOutputChars: number;
  /** Overrides of the per-turn limits (long jobs such as report research); default: the chat's. */
  maxCalls?: number;
  maxTotalChars?: number;
}

/** Builds the per-turn toolset: one instance per chat turn, so the counters below are per turn. */
export function buildLibraryChatTools(deps: LibraryToolsDeps): LibraryChatTools {
  const { library, documents, engine } = deps;
  const ready = documents.filter((d) => d.status === 'ready');
  const namesForTool = (ready.length ? ready : documents).map((d) => d.name);
  const maxCalls = deps.maxCalls ?? LIBRARY_TOOL_MAX_CALLS_PER_TURN;
  const maxTotalChars = deps.maxTotalChars ?? LIBRARY_TOOL_MAX_TOTAL_CHARS_PER_TURN;
  let calls = 0;
  let totalChars = 0;

  return {
    libraryId: library.id,
    libraryName: library.name,
    systemNote: systemNote(library, documents.length, ready.length),
    tools: [toolDefinition(library, namesForTool)],
    async call(name, args, signal) {
      if (name !== LIBRARY_TOOL_NAME)
        return { text: `Ferramenta desconhecida: ${name}`, isError: true };
      const query = typeof args.consulta === 'string' ? args.consulta.trim() : '';
      if (!query)
        return { text: 'Parâmetro "consulta" é obrigatório (texto não vazio).', isError: true };

      const remaining = maxTotalChars - totalChars;
      if (calls >= maxCalls || remaining < MIN_USEFUL_CHARS)
        return { text: LIBRARY_TURN_LIMIT_TEXT, isError: false };
      calls += 1;

      const requestedK = Number(args.max_trechos);
      const k = Number.isFinite(requestedK)
        ? Math.min(Math.max(Math.trunc(requestedK), 1), MAX_TOP_K)
        : DEFAULT_TOP_K;
      const maxChars = Math.max(
        Math.min(LIBRARY_TOOL_MAX_CHARS, deps.maxOutputChars, remaining),
        1,
      );
      let result: LibraryToolResult;
      try {
        result = await engine.search(library, query.slice(0, MAX_QUERY_CHARS), {
          k,
          maxChars,
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        return { text: 'Falha ao consultar a biblioteca. Responda sem ela.', isError: true };
      }
      const text = result.text.length > maxChars ? result.text.slice(0, maxChars) : result.text;
      totalChars += text.length;
      return { text, isError: result.isError };
    },
  };
}
