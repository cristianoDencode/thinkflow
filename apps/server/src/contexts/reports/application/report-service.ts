import {
  reportCreateSchema,
  reportToLibrarySchema,
  reportListQuerySchema,
  reportSectionRegenerateSchema,
  reportSettingsSchema,
  reportSettingsUpdateSchema,
  reportUpdateSchema,
  type ReportDetailDto,
  type ReportDto,
  type ReportRendererStatusDto,
  type ReportSectionDto,
  type ReportSettings,
  type ReportToLibraryResultDto,
} from '@thinkflow/shared';
import { buildCarryOver, groupTurns } from '../../chat/domain/context-window';
import type { Clock } from '../../../shared/kernel/clock';
import { ConflictError, DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import {
  ObjectStoreUnavailableError,
  type ObjectStream,
} from '../../../shared/kernel/object-store';
import { slugify } from '../domain/assembly';
import { artifactVersion, isLegacyPdfKey } from '../domain/artifact-keys';
import {
  NEW_VERSION_STORAGE_STATE,
  NOTE_MAX_CHARS,
  emptyMeta,
  isActive,
  isTerminal,
  progressLabel,
  toListItem,
  type Report,
  type ReportListItem,
  type ReportNote,
  type ReportProgress,
  type ReportSection,
} from '../domain/report';
import type { ConversationReaderPort, ReportRepository } from '../domain/report-ports';
import type {
  DiagramRenderer,
  LegacyPdfSource,
  LibraryIngestPort,
  PdfRenderer,
  ReportArtifactRef,
  ReportArtifactStore,
} from '../domain/render-ports';
import {
  missingVariables,
  resolveTitle,
  resolveVariables,
  type ReportTemplate,
} from '../domain/template';
import type { ReportIntakePort } from './report-intake';
import type { ReportDocumentBuilder } from './report-document';
import type { ReportJob } from './report-runner';

const CONVERSATION_RECENT_TURNS = 6;
const CONVERSATION_CARRY_TOKENS = 3_000;
const INTAKE_RECENT_TURNS = 10;
const INTAKE_TRANSCRIPT_TOKENS = 4_000;

/** The slice of the runner the service uses. */
export interface ReportJobRunner {
  enqueue(job: ReportJob): void;
  cancel(reportId: string, options?: { wait?: boolean }): Promise<void>;
  prepareResume(report: Pick<Report, 'id' | 'researchDone'>): Promise<void>;
}

export interface ReportServiceDeps {
  repo: ReportRepository;
  runner: ReportJobRunner;
  templates: { find(id: string): Promise<ReportTemplate | null> };
  conversations?: ConversationReaderPort;
  /** Fills missing variables from the chat transcript ("Gerar agora"). */
  intake?: ReportIntakePort;
  settings: { get(): ReportSettings; set(value: ReportSettings): void };
  clock: Clock;
  ids: IdGenerator;
  /** Called after a report is deleted (pruned or by the user), once its stored documents are removed. */
  onDeleted?: (report: Report) => Promise<void> | void;
  /** A document was saved in the staging column (assembly or rebuild): the sync worker uploads it. */
  onAssembled?: (reportId: string) => void;
  /** Non-fatal storage problem (e.g. PDF not cached, objects left for the janitor). */
  onStorageError?: (err: unknown, action: string, reportId: string) => void;
  /** Rendering: HTML builder, PDF renderer + object-store cache and "Adicionar à Biblioteca". */
  rendering: {
    documents: ReportDocumentBuilder;
    pdf: PdfRenderer;
    diagrams: DiagramRenderer;
    artifacts: ReportArtifactStore;
    /** Pre-object-store PDF cache (`DATA_DIR/reports/<id>.pdf`): served until the backfill moves it. */
    legacyPdf?: LegacyPdfSource;
    library: LibraryIngestPort;
  };
}

/** A document ready to send: in memory, or streamed from the object store (must be consumed/aborted). */
export type DocumentBody = string | Uint8Array | ObjectStream;

const toProgressDto = (p: ReportProgress) => ({
  phase: p.phase,
  current: p.current,
  total: p.total,
  label: p.label,
});

function toDto(item: ReportListItem): ReportDto {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    templateId: item.templateId,
    templateName: item.templateName,
    status: item.status,
    progress: toProgressDto(item.progress),
    error: item.error,
    failedPhase: item.failedPhase,
    cancelRequested: item.cancelRequested,
    model: item.model,
    variables: item.variables,
    libraryId: item.libraryId,
    useMcp: item.useMcp,
    conversationId: item.conversationId,
    researchDone: item.researchDone,
    researchTotal: item.researchTotal,
    sectionCount: item.sectionCount,
    hasMarkdown: item.hasMarkdown,
    hasHtml: item.hasHtml,
    hasPdf: item.hasPdf,
    storage: item.storage,
    meta: item.meta,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
  };
}

const toSectionDto = (s: ReportSection): ReportSectionDto => ({
  ordinal: s.ordinal,
  title: s.title,
  role: s.role,
  status: s.status,
  markdown: s.markdown,
  noteCount: s.noteIds.length,
  model: s.model,
  providerId: s.providerId,
  warnings: s.warnings,
  error: s.error,
  updatedAt: s.updatedAt,
});

const artifactRef = (
  reportId: string,
  version: string,
  artifact: ReportArtifactRef['artifact'],
): ReportArtifactRef => ({ reportId, version, artifact });

export class ReportService {
  private readonly pdfInFlight = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly deps: ReportServiceDeps) {}

  /* ------------------------------ queries ------------------------------ */

  async list(query: unknown): Promise<ReportDto[]> {
    const parsed = reportListQuerySchema.parse(query);
    return (await this.deps.repo.list(parsed)).map(toDto);
  }

  async get(id: string): Promise<ReportDetailDto> {
    const report = await this.require(id);
    const [sections, notes] = await Promise.all([
      this.deps.repo.sections(id),
      this.deps.repo.notes(id),
    ]);
    return {
      ...toDto(toListItem(report, sections.length)),
      brief: report.brief,
      markdown: report.markdown,
      sections: sections.map(toSectionDto),
      plan: report.plan
        ? report.plan.map((step) => ({ objective: step.objective, sections: step.sections }))
        : null,
      noteCount: notes.length,
    };
  }

  /** The assembled Markdown and a download-safe file name. */
  async markdown(id: string): Promise<{ filename: string; text: string }> {
    const report = await this.require(id);
    if (report.status !== 'done' || report.markdown === null)
      throw new DomainError('O relatório ainda não está pronto.', 'report_not_ready', 409);
    return { filename: `${slugify(report.title)}.md`, text: report.markdown };
  }

  /**
   * The report page (the navigable page for prototypes). Comes from the staging column, else
   * streamed from the object store (503 `storage_unavailable` while it is down); rebuilt from the
   * sections when the object is missing.
   */
  async html(id: string): Promise<{ filename: string; body: string | ObjectStream }> {
    const report = await this.requireDone(id);
    return { filename: `${slugify(report.title)}.html`, body: await this.htmlBody(report) };
  }

  /**
   * PDF of the report: cached in the object store under the version of the HTML, shared between
   * concurrent requests, 503 without Chromium.
   */
  async pdf(id: string): Promise<{ filename: string; body: Uint8Array | ObjectStream }> {
    const report = await this.requireDone(id);
    if (report.kind === 'prototype')
      throw new DomainError(
        'Protótipos não têm PDF; use "Abrir protótipo" ou baixe o HTML.',
        'pdf_not_supported',
        400,
      );
    const filename = `${slugify(report.title)}.pdf`;
    if (report.pdfKey) {
      const cached = await this.cachedPdf(report, report.pdfKey);
      if (cached) return { filename, body: cached };
    }
    const pending = this.pdfInFlight.get(id);
    if (pending) return { filename, body: await pending };
    const job = this.renderPdf(report).finally(() => this.pdfInFlight.delete(id));
    this.pdfInFlight.set(id, job);
    return { filename, body: await job };
  }

  /** The cached PDF (legacy file or object), or null when it has to be rendered again. */
  private async cachedPdf(
    report: Report,
    pdfKey: string,
  ): Promise<Uint8Array | ObjectStream | null> {
    if (isLegacyPdfKey(pdfKey)) {
      return (await this.deps.rendering.legacyPdf?.read(report.id).catch(() => null)) ?? null;
    }
    if (!report.htmlHash) return null;
    try {
      return await this.deps.rendering.artifacts.stream(
        artifactRef(report.id, report.htmlHash, 'pdf'),
      );
    } catch (err) {
      // with the HTML still in staging the PDF can be printed again without the storage
      if (err instanceof ObjectStoreUnavailableError && report.html !== null) {
        this.deps.onStorageError?.(err, 'pdf-cache-read', report.id);
        return null;
      }
      throw err;
    }
  }

  private async renderPdf(report: Report): Promise<Uint8Array> {
    const { pdf, artifacts } = this.deps.rendering;
    const status = await pdf.status();
    if (!status.available)
      throw new DomainError(
        `Não foi possível gerar o PDF neste servidor. ${status.reason ?? ''} Use "Baixar HTML" e imprima pelo navegador.`.trim(),
        'pdf_unavailable',
        503,
      );
    const { html, hash } = await this.loadHtml(report);
    let bytes: Uint8Array;
    try {
      bytes = await pdf.pdf(html, this.deps.rendering.documents.pdfOptions(report));
    } catch (err) {
      throw new DomainError(`Falha ao gerar o PDF: ${(err as Error).message}`, 'pdf_failed', 500);
    }
    // cache only if the document did not change while it was being printed; a storage failure
    // never prevents the delivery
    const fresh = await this.deps.repo.findById(report.id);
    if (fresh && fresh.status === 'done' && fresh.htmlHash === hash) {
      const ref = artifactRef(report.id, hash, 'pdf');
      try {
        await artifacts.put(ref, bytes, { kind: report.kind, templateId: report.templateId });
        await this.deps.repo.setPdfKeyIf(
          report.id,
          hash,
          artifacts.key(ref),
          this.deps.clock.now(),
        );
      } catch (err) {
        this.deps.onStorageError?.(err, 'pdf-cache-write', report.id);
      }
    }
    return bytes;
  }

  /** The HTML to send: staging column, else the object store (streamed), else rebuilt. */
  private async htmlBody(report: Report): Promise<string | ObjectStream> {
    if (report.html !== null) return report.html;
    if (report.htmlHash) {
      const stream = await this.deps.rendering.artifacts.stream(
        artifactRef(report.id, report.htmlHash, 'html'),
      );
      if (stream) return stream;
      this.deps.onStorageError?.(new Error('objeto do HTML ausente'), 'html-missing', report.id);
    }
    return (await this.rebuild(report)).html;
  }

  /** The HTML as text with its version (for the PDF): same order as `htmlBody`. */
  private async loadHtml(report: Report): Promise<{ html: string; hash: string }> {
    if (report.html !== null)
      return { html: report.html, hash: report.htmlHash ?? artifactVersion(report.html) };
    if (report.htmlHash) {
      const bytes = await this.deps.rendering.artifacts.read(
        artifactRef(report.id, report.htmlHash, 'html'),
      );
      if (bytes) return { html: new TextDecoder().decode(bytes), hash: report.htmlHash };
      this.deps.onStorageError?.(new Error('objeto do HTML ausente'), 'html-missing', report.id);
    }
    const built = await this.rebuild(report);
    return { html: built.html, hash: built.htmlHash };
  }

  /** "Adicionar à Biblioteca": the report's Markdown becomes a library document. */
  async addToLibrary(id: string, body: unknown): Promise<ReportToLibraryResultDto> {
    const { libraryId } = reportToLibrarySchema.parse(body);
    const report = await this.requireDone(id);
    const name = `${slugify(report.title)}.md`;
    const result = await this.deps.rendering.library.addMarkdown(
      libraryId,
      name,
      report.markdown ?? '',
    );
    if ('rejected' in result) throw new ConflictError(result.rejected);
    const meta = report.meta;
    if (!meta.libraryDocuments.some((d) => d.documentId === result.documentId)) {
      await this.deps.repo.update(id, {
        meta: {
          ...meta,
          libraryDocuments: [
            ...meta.libraryDocuments,
            { libraryId, documentId: result.documentId },
          ],
        },
        updatedAt: this.deps.clock.now(),
      });
    }
    return { documentId: result.documentId, libraryId, name: result.name };
  }

  async rendererStatus(): Promise<ReportRendererStatusDto> {
    const { pdf, diagrams } = this.deps.rendering;
    const [p, d] = await Promise.all([pdf.status(), diagrams.status()]);
    return {
      pdf: p.available,
      diagrams: d.available,
      reason: p.reason ?? d.reason,
      executablePath: p.executablePath ?? d.executablePath,
    };
  }

  settings(): ReportSettings {
    return this.deps.settings.get();
  }

  updateSettings(body: unknown): ReportSettings {
    const patch = reportSettingsUpdateSchema.parse(body);
    const next = reportSettingsSchema.parse({ ...this.deps.settings.get(), ...patch });
    this.deps.settings.set(next);
    return next;
  }

  /* ------------------------------ commands ------------------------------ */

  /** Phase 0 (inputs): validates, snapshots the template, stores the notes and queues the job. */
  async create(body: unknown): Promise<ReportDto> {
    const input = reportCreateSchema.parse(body);
    const template = await this.deps.templates.find(input.templateId);
    if (!template) throw new NotFoundError('Modelo');
    const spec = template.spec;
    const conversationId = input.conversationId ?? null;
    const conversation =
      conversationId && this.deps.conversations
        ? await this.deps.conversations.read(conversationId)
        : null;

    let values = input.variables;
    let brief = input.brief;
    let missing = missingVariables(spec, values);
    if (missing.length > 0 && conversation && this.deps.intake) {
      // the user pressed "Gerar agora": read the answers from the conversation
      const transcript = buildCarryOver(
        conversation.summary,
        groupTurns(conversation.messages).slice(-INTAKE_RECENT_TURNS),
        INTAKE_TRANSCRIPT_TOKENS,
      );
      const extracted = transcript
        ? await this.deps.intake.extract(template, transcript, input.model)
        : null;
      if (extracted) {
        const given = Object.fromEntries(
          Object.entries(input.variables).filter(([, value]) => value.trim()),
        );
        const found = Object.fromEntries(
          Object.entries(extracted.variables).filter(([, value]) => value.trim()),
        );
        values = { ...found, ...given };
        if (!brief) brief = extracted.brief;
        missing = missingVariables(spec, values);
      }
    }
    if (missing.length > 0) {
      const labels = missing.map(
        (name) => spec.variables.find((v) => v.name === name)?.label ?? name,
      );
      throw new DomainError(
        `${conversation ? 'Responda na conversa' : 'Preencha'}: ${labels.join(', ')}.`,
        'report_missing_variables',
        422,
      );
    }
    const variables = resolveVariables(spec, values);
    const now = this.deps.clock.now();
    const id = this.deps.ids.next();

    const inputNotes: ReportNote[] = [];
    let ordinal = 0;
    const addNote = (n: Pick<ReportNote, 'source' | 'query' | 'content'>) =>
      inputNotes.push({
        id: this.deps.ids.next(),
        reportId: id,
        step: 0,
        ordinal: ordinal++,
        source: n.source,
        toolName: null,
        query: n.query,
        content: n.content.slice(0, NOTE_MAX_CHARS),
        sectionHints: [],
        createdAt: now,
      });

    let briefText = brief;
    if (conversation) {
      const carry = buildCarryOver(
        conversation.summary,
        groupTurns(conversation.messages).slice(-CONVERSATION_RECENT_TURNS),
        CONVERSATION_CARRY_TOKENS,
      );
      if (carry) briefText = [briefText, carry].filter(Boolean).join('\n\n');
      for (const message of conversation.messages) {
        if (message.role !== 'user') continue;
        for (const a of message.meta.attachments ?? []) {
          if (a.excerpt) addNote({ source: 'attachment', query: a.name, content: a.excerpt });
        }
      }
    }
    if (briefText.trim())
      addNote({ source: 'brief', query: null, content: `Pedido do usuário:\n${briefText}` });

    const report: Report = {
      id,
      title: input.title ?? resolveTitle(spec, variables, template.name),
      kind: template.kind,
      templateId: template.id,
      templateName: template.name,
      templateSnapshot: structuredClone(spec),
      status: 'queued',
      progress: { phase: 'queued', current: 0, total: 0, label: progressLabel('queued', 0, 0) },
      error: null,
      failedPhase: null,
      cancelRequested: false,
      model: input.model,
      variables,
      brief,
      libraryId: input.libraryId ?? null,
      useMcp: input.useMcp ?? spec.research.useMcp,
      conversationId,
      plan: null,
      researchDone: 0,
      outline: null,
      html: null,
      markdown: null,
      meta: emptyMeta(),
      pdfKey: null,
      pdfAt: null,
      htmlHash: null,
      ...NEW_VERSION_STORAGE_STATE,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    await this.deps.repo.create(report);
    if (inputNotes.length > 0) await this.deps.repo.addNotes(inputNotes);
    await this.prune(id);
    this.deps.runner.enqueue({ reportId: id, spec: { type: 'generate' } });
    return toDto(toListItem(report, 0));
  }

  async rename(id: string, body: unknown): Promise<ReportDto> {
    const { title } = reportUpdateSchema.parse(body);
    const report = await this.require(id);
    await this.deps.repo.update(id, { title, updatedAt: this.deps.clock.now() });
    if (report.status === 'done' && report.markdown !== null) {
      // the title is part of the document: build it again (a new version, so the PDF is stale)
      await this.rebuild({ ...report, title });
    }
    return this.dto(id);
  }

  /** Stops the job (waiting for it) and deletes the report with its sections and notes. */
  async delete(id: string): Promise<void> {
    const report = await this.require(id);
    if (isActive(report.status)) await this.deps.runner.cancel(id, { wait: true });
    await this.deps.repo.delete(id);
    await this.cleanup(report);
  }

  async cancel(id: string): Promise<ReportDto> {
    const report = await this.require(id);
    if (!isActive(report.status)) throw new ConflictError('Este relatório não está em andamento.');
    await this.deps.runner.cancel(id);
    return this.dto(id);
  }

  /** Resumes a failed or canceled report from the state it saved. */
  async retry(id: string): Promise<ReportDto> {
    const report = await this.require(id);
    if (report.status !== 'error' && report.status !== 'canceled')
      throw new ConflictError('Só é possível retomar relatórios com erro ou cancelados.');
    await this.deps.runner.prepareResume(report);
    await this.deps.repo.update(id, {
      status: 'queued',
      progress: { phase: 'queued', current: 0, total: 0, label: progressLabel('queued', 0, 0) },
      error: null,
      failedPhase: null,
      cancelRequested: false,
      finishedAt: null,
      updatedAt: this.deps.clock.now(),
    });
    this.deps.runner.enqueue({ reportId: id, spec: { type: 'generate' } });
    return this.dto(id);
  }

  /** Rewrites one section (optionally with instructions) and re-assembles the document. */
  async regenerateSection(id: string, ordinal: number, body: unknown): Promise<ReportDto> {
    const input = reportSectionRegenerateSchema.parse(body);
    const report = await this.require(id);
    if (report.status !== 'done')
      throw new ConflictError('Só é possível reescrever seções de relatórios concluídos.');
    const sections = await this.deps.repo.sections(id);
    if (!sections.some((s) => s.ordinal === ordinal && s.role === 'section'))
      throw new NotFoundError('Seção');
    const job = {
      type: 'section' as const,
      ordinal,
      instructions: input.instructions,
      model: input.model ?? null,
    };
    await this.deps.repo.update(id, {
      status: 'writing',
      progress: {
        phase: 'writing',
        current: ordinal,
        total: sections.length,
        label: 'Na fila para reescrever a seção…',
        job,
      },
      updatedAt: this.deps.clock.now(),
    });
    this.deps.runner.enqueue({ reportId: id, spec: job });
    return this.dto(id);
  }

  /* ------------------------------ helpers ------------------------------ */

  private async require(id: string): Promise<Report> {
    const report = await this.deps.repo.findById(id);
    if (!report) throw new NotFoundError('Relatório');
    return report;
  }

  private async requireDone(id: string): Promise<Report> {
    const report = await this.require(id);
    if (report.status !== 'done' || report.markdown === null)
      throw new DomainError('O relatório ainda não está pronto.', 'report_not_ready', 409);
    return report;
  }

  /**
   * Builds Markdown + HTML again from the saved sections and puts them in the staging column
   * (a new version: the PDF of the old one is dropped and the sync worker uploads the new one).
   */
  private async rebuild(
    report: Report,
  ): Promise<{ html: string; markdown: string; htmlHash: string }> {
    const sections = await this.deps.repo.sections(report.id);
    const built = await this.deps.rendering.documents.build(
      report,
      sections,
      report.meta,
      report.meta.generatedAt ?? this.deps.clock.now(),
    );
    await this.deps.repo.update(report.id, {
      html: built.html,
      htmlHash: built.htmlHash,
      ...NEW_VERSION_STORAGE_STATE,
      markdown: built.markdown,
      meta: built.meta,
      pdfKey: null,
      pdfAt: null,
      updatedAt: this.deps.clock.now(),
    });
    this.deps.onAssembled?.(report.id);
    return { html: built.html, markdown: built.markdown, htmlHash: built.htmlHash };
  }

  private async dto(id: string): Promise<ReportDto> {
    const report = await this.require(id);
    const sections = await this.deps.repo.sections(id);
    return toDto(toListItem(report, sections.length));
  }

  /**
   * What goes away with a deleted report besides its rows: every stored document (HTML, PDF, Markdown
   * copy) and the legacy PDF file. A storage failure is only logged: the janitor finishes the job.
   */
  private async cleanup(report: Report): Promise<void> {
    const { artifacts, legacyPdf } = this.deps.rendering;
    await artifacts
      .deleteReport(report.id)
      .catch((err: unknown) => this.deps.onStorageError?.(err, 'delete', report.id));
    await legacyPdf
      ?.delete(report.id)
      .catch((err: unknown) => this.deps.onStorageError?.(err, 'delete-legacy-pdf', report.id));
    await this.deps.onDeleted?.(report);
  }

  /** Keeps at most `keepReports` finished reports (the oldest go first, never the new one). */
  private async prune(exceptId: string): Promise<void> {
    const keep = this.deps.settings.get().keepReports;
    const removed = await this.deps.repo.pruneOldest(keep);
    for (const report of removed) {
      if (report.id === exceptId || !isTerminal(report.status)) continue;
      await this.cleanup(report);
    }
  }
}
