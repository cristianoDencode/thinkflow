import type { LibrarySearchHitDto } from '@thinkflow/shared';
import type { LibraryEngine, LibraryToolResult } from '../domain/engine';
import type { Library, LibraryEngineKind } from '../domain/library';
import type { ChunkIndex, LibraryRepository } from '../domain/ports';
import { buildFtsQuery, makeExcerpt, selectHits } from '../domain/retrieval';
import { formatNoResults, formatSearchResult, type FormatHit } from '../domain/tool-format';

const HIT_EXCERPT_CHARS = 600;
/** Candidates fetched from the index per requested hit, before the per-document cap and merging. */
const OVERFETCH = 4;

/** BM25 search over the local FTS5 index. */
export class LocalEngine implements LibraryEngine {
  readonly kind: LibraryEngineKind = 'local';

  constructor(private readonly deps: { index: ChunkIndex; repo: LibraryRepository }) {}

  async search(
    library: Library,
    question: string,
    opts: { k: number; maxChars: number; signal?: AbortSignal },
  ): Promise<LibraryToolResult> {
    const docs = await this.deps.repo.documents(library.id);
    const names = new Map(docs.map((d) => [d.id, d.name]));
    const parsed = buildFtsQuery(question);
    const raw = parsed
      ? await this.deps.index.search(library.id, parsed.query, opts.k * OVERFETCH)
      : [];
    const selected = selectHits(raw, { k: opts.k });
    if (!parsed || selected.length === 0) {
      return {
        text: formatNoResults(
          library,
          question,
          docs.filter((d) => d.status === 'ready').map((d) => d.name),
          opts.maxChars,
        ),
        isError: false,
        citations: [],
        hits: [],
      };
    }

    const formatHits: FormatHit[] = selected.map((h) => ({
      documentName: names.get(h.documentId) ?? 'Documento',
      heading: h.heading,
      pageFrom: h.pageFrom,
      pageTo: h.pageTo,
      text: h.text,
    }));
    const hits: LibrarySearchHitDto[] = selected.map((h, i) => ({
      documentId: h.documentId,
      documentName: formatHits[i]!.documentName,
      heading: h.heading,
      pageFrom: h.pageFrom,
      pageTo: h.pageTo,
      excerpt: makeExcerpt(h.text, parsed.terms, HIT_EXCERPT_CHARS),
      score: Math.round(-h.score * 1000) / 1000,
    }));
    return {
      text: formatSearchResult(library, formatHits, parsed.terms, { maxChars: opts.maxChars }),
      isError: false,
      citations: selected.map((h, i) => ({
        documentId: h.documentId,
        documentName: formatHits[i]!.documentName,
        page: h.pageFrom,
      })),
      hits,
    };
  }
}
