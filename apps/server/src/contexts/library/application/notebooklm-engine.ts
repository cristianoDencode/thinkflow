import type { LibrarySearchHitDto } from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import type { LibraryEngine, LibraryToolResult } from '../domain/engine';
import type { Library, LibraryDocument, LibraryEngineKind } from '../domain/library';
import { dayKey, effectiveNotebookLmLimits, sourceLimitMessage } from '../domain/notebooklm';
import {
  NotebookLmError,
  type DocumentFileStore,
  type LibraryRepository,
  type LibraryUsageRecorder,
  type NotebookLmConfigStore,
  type NotebookLmErrorKind,
  type NotebookLmGateway,
} from '../domain/ports';
import { formatFallback, formatNotebookAnswer } from '../domain/tool-format';
import { toDomainError } from './notebooklm-settings-service';

/** How long a document may take to become ready in NotebookLM before the sync is given up. */
const SYNC_READY_TIMEOUT_MS = 300_000;
/**
 * `source wait` holds the gateway's single CLI slot while it runs, so waiting happens in short
 * slices: chat questions queued behind a sync only wait for one slice, not for the whole import.
 */
const WAIT_SLICE_MS = 20_000;
const HIT_EXCERPT_CHARS = 600;
const REMOTE_ERROR_MAX = 300;

const REASONS: Record<NotebookLmErrorKind, string> = {
  not_configured: 'não configurado',
  auth: 'credenciais expiradas',
  rate_limited: 'limite de uso do NotebookLM atingido',
  timeout: 'tempo esgotado',
  unavailable: 'serviço indisponível',
  bad_response: 'resposta inesperada',
  cli_missing: 'CLI do NotebookLM não encontrada',
  source_limit: 'limite de fontes do notebook atingido',
};

const SYNC_MESSAGES: Record<NotebookLmErrorKind, string> = {
  not_configured: 'NotebookLM não configurado',
  auth: 'Credenciais do NotebookLM expiradas. Entre novamente com o Google e sincronize de novo.',
  rate_limited: 'Limite de uso do NotebookLM atingido. Tente sincronizar mais tarde.',
  timeout: 'O NotebookLM demorou demais para processar o documento.',
  unavailable: 'NotebookLM indisponível.',
  bad_response: 'Resposta inesperada do NotebookLM.',
  cli_missing: 'CLI do NotebookLM não encontrada. Verifique as configurações.',
  source_limit: 'O notebook atingiu o limite de fontes da conta do NotebookLM.',
};

export interface NotebookLmEngineDeps {
  repo: LibraryRepository;
  files: DocumentFileStore;
  gateway: NotebookLmGateway;
  config: NotebookLmConfigStore;
  /** The same documents are always indexed locally: used as fallback. */
  local: LibraryEngine;
  usage?: LibraryUsageRecorder;
  clock: Clock;
  onError?: (err: unknown) => void;
  /** Test knobs. */
  syncTimeoutMs?: number;
  waitSliceMs?: number;
}

/**
 * Experimental engine: the question goes straight to the library's NotebookLM notebook and its
 * cited answer is what the AI receives. Documents are uploaded as notebook sources by the remote
 * lane of the ingestion queue; when NotebookLM is unavailable the local index answers instead
 * (unless the user turned the fallback off).
 */
export class NotebookLmEngine implements LibraryEngine {
  readonly kind: LibraryEngineKind = 'notebooklm';

  constructor(private readonly deps: NotebookLmEngineDeps) {}

  /** True when the integration is switched on and has a Google session. */
  isConfigured(): boolean {
    const c = this.deps.config.get();
    return c.enabled && c.authJson !== null;
  }

  /** Sources per notebook the connected account allows (detected → chosen plan → Free). */
  sourceLimit(): number {
    return effectiveNotebookLmLimits(this.deps.config.get()).sourceLimit;
  }

  async onLibraryCreated(library: Library): Promise<Partial<Library>> {
    try {
      const nb = await this.deps.gateway.createNotebook(`Thinkflow — ${library.name}`);
      return { remoteNotebookId: nb.id };
    } catch (err) {
      throw toDomainError(err);
    }
  }

  async onLibraryDeleted(library: Library): Promise<void> {
    if (!library.remoteNotebookId) return;
    await this.deps.gateway.deleteNotebook(library.remoteNotebookId);
  }

  async onDocumentDeleted(library: Library, doc: LibraryDocument): Promise<void> {
    if (!library.remoteNotebookId || !doc.remoteSourceId) return;
    await this.deps.gateway.deleteSource(library.remoteNotebookId, doc.remoteSourceId);
  }

  /** Remote lane: uploads the original file as a notebook source and waits until it is usable. */
  async onDocumentIndexed(library: Library, doc: LibraryDocument): Promise<void> {
    const { repo, gateway, files, clock } = this.deps;
    const patch = async (fields: Partial<LibraryDocument>) => {
      try {
        await repo.updateDocument(doc.id, { ...fields, updatedAt: clock.now() });
      } catch {
        /* deleted meanwhile */
      }
    };
    if (!this.isConfigured()) {
      return patch({ remoteStatus: 'error', remoteError: SYNC_MESSAGES.not_configured });
    }
    const notebookId = library.remoteNotebookId;
    if (!notebookId) {
      return patch({
        remoteStatus: 'error',
        remoteError: 'A biblioteca não tem caderno no NotebookLM',
      });
    }

    await patch({ remoteStatus: 'syncing', remoteError: null });
    // a retry replaces a source left over by a previous attempt
    if (doc.remoteSourceId) {
      await gateway.deleteSource(notebookId, doc.remoteSourceId).catch(() => undefined);
      await patch({ remoteSourceId: null });
    }
    let sourceId: string | null = null;
    try {
      ({ sourceId } = await gateway.addSource(notebookId, {
        bytes: await files.read(doc.storageKey),
        fileName: doc.storageKey.slice(doc.storageKey.lastIndexOf('/') + 1),
        title: doc.name,
        mimeType: doc.mimeType,
      }));
      if (!(await repo.findDocument(doc.id))) {
        // deleted while uploading: do not leave an orphan source behind
        await gateway.deleteSource(notebookId, sourceId).catch(() => undefined);
        return;
      }
      await patch({ remoteSourceId: sourceId });
      await this.waitReady(notebookId, sourceId);
      await patch({ remoteStatus: 'synced', remoteError: null });
    } catch (err) {
      if (!(err instanceof NotebookLmError)) this.deps.onError?.(err);
      else if (err.kind === 'auth') this.noteAuthFailure();
      else if (err.kind === 'source_limit') this.learnSourceLimit(err);
      await patch({
        remoteStatus: 'error',
        remoteError: syncMessage(err, this.sourceLimit()),
        ...(sourceId ? { remoteSourceId: sourceId } : {}),
      });
    }
  }

  private async waitReady(notebookId: string, sourceId: string): Promise<void> {
    const total = this.deps.syncTimeoutMs ?? SYNC_READY_TIMEOUT_MS;
    const slice = Math.min(this.deps.waitSliceMs ?? WAIT_SLICE_MS, total);
    const attempts = Math.max(Math.ceil(total / slice), 1);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.deps.gateway.waitSourceReady(notebookId, sourceId, slice);
        return;
      } catch (err) {
        const retry =
          err instanceof NotebookLmError && err.kind === 'timeout' && attempt < attempts;
        if (!retry) throw err;
      }
    }
  }

  /**
   * The account said "no more sources": remember the number it gave, so uploads stop at the real
   * limit. The document stays in `error` (no automatic retry); "Sincronizar de novo" is manual.
   */
  private learnSourceLimit(err: NotebookLmError): void {
    if (!err.limit) return;
    const detected = this.deps.config.get().detected;
    this.deps.config.set({
      detected: {
        at: this.deps.clock.now(),
        sourceLimit: err.limit,
        notebookLimit: detected?.notebookLimit ?? null,
        tier: detected?.tier ?? null,
      },
    });
  }

  private noteAuthFailure(): void {
    this.deps.config.set({
      lastCheck: {
        at: this.deps.clock.now(),
        ok: false,
        message: 'Credenciais expiradas',
        account: null,
      },
    });
  }

  async search(
    library: Library,
    question: string,
    opts: { k: number; maxChars: number; signal?: AbortSignal },
  ): Promise<LibraryToolResult> {
    const { config, gateway, repo, clock } = this.deps;
    const cfg = config.get();
    if (!cfg.enabled || cfg.authJson === null)
      return this.unavailable(library, question, opts, REASONS.not_configured);
    if (!library.remoteNotebookId)
      return this.unavailable(library, question, opts, 'biblioteca sem caderno no NotebookLM');

    const today = dayKey(clock.now());
    const dailyLimit = effectiveNotebookLmLimits(cfg).chatsPerDay;
    if (config.queriesOn(today) >= dailyLimit)
      return this.unavailable(
        library,
        question,
        opts,
        `limite diário de ${dailyLimit} consultas atingido`,
      );

    const docs = await repo.documents(library.id);
    const synced = docs.filter((d) => d.remoteStatus === 'synced' && d.remoteSourceId);
    if (synced.length === 0)
      return this.unavailable(library, question, opts, 'nenhum documento sincronizado ainda');
    const bySource = new Map(synced.map((d) => [d.remoteSourceId!, d]));
    // restrict the question to synced sources only while others are still being uploaded
    const sourceIds = synced.length === docs.length ? undefined : [...bySource.keys()];

    config.countQuery(today);
    try {
      const res = await gateway.ask(library.remoteNotebookId, question, {
        ...(sourceIds ? { sourceIds } : {}),
        timeoutMs: cfg.timeoutSec * 1000,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      this.record(question, res.answer, true);
      const names = new Map([...bySource].map(([id, d]) => [id, d.name]));
      const citations: LibraryToolResult['citations'] = [];
      const hits: LibrarySearchHitDto[] = [];
      for (const ref of res.references) {
        const doc = bySource.get(ref.sourceId);
        if (!doc) continue;
        if (!citations.some((c) => c.documentId === doc.id))
          citations.push({ documentId: doc.id, documentName: doc.name });
        hits.push({
          documentId: doc.id,
          documentName: doc.name,
          heading: null,
          pageFrom: null,
          pageTo: null,
          excerpt: ref.citedText.slice(0, HIT_EXCERPT_CHARS),
          score: 0,
        });
      }
      return {
        text: formatNotebookAnswer(library, res.answer, res.references, names, {
          maxChars: opts.maxChars,
        }),
        isError: false,
        citations,
        hits,
      };
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      this.record(question, '', false);
      const kind: NotebookLmErrorKind = err instanceof NotebookLmError ? err.kind : 'unavailable';
      if (!(err instanceof NotebookLmError)) this.deps.onError?.(err);
      if (kind === 'auth') this.noteAuthFailure();
      return this.unavailable(library, question, opts, REASONS[kind]);
    }
  }

  /** Fallback to the local index of the same documents, or an error when the user turned it off. */
  private async unavailable(
    library: Library,
    question: string,
    opts: { k: number; maxChars: number; signal?: AbortSignal },
    reason: string,
  ): Promise<LibraryToolResult> {
    if (!this.deps.config.get().fallbackToLocal) {
      return {
        text: `NotebookLM indisponível: ${reason}. A busca local está desativada nas configurações.`,
        isError: true,
        citations: [],
        hits: [],
      };
    }
    const prefix = formatFallback(reason, '');
    const local = await this.deps.local.search(library, question, {
      ...opts,
      maxChars: Math.max(opts.maxChars - prefix.length, 1),
    });
    return { ...local, text: prefix + local.text };
  }

  private record(question: string, answer: string, success: boolean): void {
    this.deps.usage?.record({
      source: 'library-notebooklm',
      providerId: 'notebooklm',
      model: 'notebooklm',
      success,
      inputTokens: Math.ceil(question.length / 4),
      outputTokens: Math.ceil(answer.length / 4),
    });
  }
}

function syncMessage(err: unknown, sourceLimit: number): string {
  if (err instanceof NotebookLmError) {
    if (err.kind === 'source_limit') return sourceLimitMessage(err.limit ?? sourceLimit);
    // "unavailable" carries the CLI's own explanation (e.g. the document could not be processed)
    const text = err.kind === 'unavailable' && err.message ? err.message : SYNC_MESSAGES[err.kind];
    return text.slice(0, REMOTE_ERROR_MAX);
  }
  return 'Falha ao sincronizar com o NotebookLM';
}
