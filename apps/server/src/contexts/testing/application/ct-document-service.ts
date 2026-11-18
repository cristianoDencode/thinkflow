import {
  ctSessionModelSchema,
  ctUpdateSchema,
  type CtFieldsDto,
  type CtLayout,
  type CtOneDriveResultDto,
  type CtStateDto,
  type TestStep,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { DomainError, NotFoundError } from '../../../shared/kernel/errors';
import {
  buildCtDocument,
  ctPlanoPlainText,
  ctStateDocument,
  resolveCtFields,
  type CtBuild,
} from '../domain/ct-build';
import { CtImageMissingError, type CtDocument } from '../domain/ct-document';
import { imageSize } from '../domain/image-size';
import type { TestImageStore, TestSessionRepository } from '../domain/ports';
import type { TestSession } from '../domain/session';
import { parseCtDocument } from './ct-document-schema';
import { imageUrl } from './test-session-service';

/** Renders the CT in each format (adapters in `infrastructure/ct`). */
export interface CtRenderers {
  docx(doc: CtDocument, images: Map<string, Uint8Array>, layout: CtLayout): Promise<Uint8Array>;
  pdf(
    doc: CtDocument,
    images: Map<string, Uint8Array>,
    layout: CtLayout,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  /** Standalone page for the on-screen preview; `imageUrl(key)` is each image's `src`. */
  previewHtml(doc: CtDocument, imageUrl: (key: string) => string, layout: CtLayout): string;
  /** Only the "Plano de Teste", with data-URI images, for pasting into Word. */
  clipboardHtml(doc: CtDocument, images: Map<string, Uint8Array>, layout: CtLayout): string;
  /** File name without extension. */
  fileStem(doc: CtDocument): string;
}

/** Where the .docx goes (OneDrive); absent in tests that do not need it. */
export interface CtPublisher {
  suggestFileName(vars: { ticketId: string; title: string }): string;
  upload(input: { fileName: string; bytes: Uint8Array }): Promise<CtOneDriveResultDto>;
}

export interface CtFile {
  body: string | Uint8Array;
  contentType: string;
  /** Set for downloads. */
  filename: string | null;
}

/** The document models (looks): resolves the one a session uses. */
export interface CtModelLookup {
  /** The id when it names an existing model, else the default model's id. */
  resolveId(id: string | undefined): Promise<string>;
  /** The look of a model (the default one when missing). */
  layoutFor(id: string | undefined): Promise<CtLayout>;
}

export interface CtDocumentServiceDeps {
  repo: TestSessionRepository;
  images: TestImageStore;
  clock: Clock;
  renderers: CtRenderers;
  models: CtModelLookup;
  publisher?: CtPublisher;
  /** Name of the logged user (default of the "Responsável" field). */
  defaultAuthor(): Promise<string>;
  /** Throws while the session is recording or running a replay. */
  assertIdle(sessionId: string): void;
}

interface Loaded {
  session: TestSession;
  fields: CtFieldsDto;
  build: CtBuild;
  images: Map<string, Uint8Array>;
  layout: CtLayout;
}

export class CtDocumentService {
  constructor(private readonly deps: CtDocumentServiceDeps) {}

  private async session(id: string): Promise<TestSession> {
    const session = await this.deps.repo.find(id);
    if (!session) throw new NotFoundError('Sessão de teste');
    return session;
  }

  private async load(sessionId: string): Promise<Loaded> {
    const session = await this.session(sessionId);
    const evidences = await this.deps.repo.evidences(sessionId);
    const stepIds = new Set(session.definition.steps.map((s) => s.id));
    const used = evidences.filter((e) => e.include && stepIds.has(e.stepId));
    const images = new Map<string, Uint8Array>();
    const imageSizes = new Map<string, { width: number; height: number }>();
    await Promise.all(
      used.map(async (e) => {
        const key = e.annotatedKey ?? e.originalKey;
        const bytes = await this.deps.images.get(key);
        if (!bytes) return;
        images.set(key, bytes);
        imageSizes.set(key, imageSize(bytes) ?? { width: e.width, height: e.height });
      }),
    );
    const now = new Date(this.deps.clock.now());
    const fields = resolveCtFields(session, await this.deps.defaultAuthor(), now);
    const build = buildCtDocument({ session, fields, evidences, imageSizes });
    const layout = await this.deps.models.layoutFor(session.definition.ct?.modelId);
    return { session, fields, build, images, layout };
  }

  /** The document, validated (the renderers trust it). */
  private document(build: CtBuild): CtDocument {
    const parsed = parseCtDocument(build.document);
    if (!parsed.ok) {
      throw new DomainError(
        `Corrija o documento antes de gerar: ${parsed.errors.join('; ')}`,
        'ct_invalid',
        400,
      );
    }
    return parsed.document;
  }

  async state(sessionId: string): Promise<CtStateDto> {
    const { session, fields, build, images } = await this.load(sessionId);
    const warnings: string[] = [];
    if (build.missingImages > 0) {
      warnings.push(
        `${build.missingImages} ${build.missingImages === 1 ? 'print não foi encontrado' : 'prints não foram encontrados'} no armazenamento e ficou fora do documento.`,
      );
    }
    return {
      fields,
      modelId: await this.deps.models.resolveId(session.definition.ct?.modelId),
      useCases: build.useCases,
      imageCount: images.size,
      document: ctStateDocument(build.document),
      itemStepIds: build.itemStepIds,
      warnings,
    };
  }

  async update(sessionId: string, body: unknown): Promise<CtStateDto> {
    const input = ctUpdateSchema.parse(body);
    const session = await this.session(sessionId);
    this.deps.assertIdle(sessionId);
    const { useCases, ...fields } = input;
    let steps = session.definition.steps;
    let firstUseCase = session.definition.ct?.firstUseCase;
    if (useCases) {
      const edits = new Map<string, { title: string; status: string }>();
      for (const edit of useCases) {
        if (edit.stepId === null) {
          firstUseCase = { title: edit.title, status: edit.status || 'Finalizado' };
        } else {
          const step = steps.find((s) => s.id === edit.stepId);
          if (step?.kind !== 'usecase') throw new NotFoundError('Caso de uso');
          edits.set(edit.stepId, { title: edit.title, status: edit.status || 'Finalizado' });
        }
      }
      steps = steps.map((s): TestStep =>
        edits.has(s.id) ? { ...s, useCase: edits.get(s.id)! } : s,
      );
    }
    await this.deps.repo.save({
      ...session,
      definition: {
        ...session.definition,
        steps,
        ct: {
          ...fields,
          ...(firstUseCase ? { firstUseCase } : {}),
          ...(session.definition.ct?.modelId ? { modelId: session.definition.ct.modelId } : {}),
        },
      },
      updatedAt: this.deps.clock.now(),
    });
    return this.state(sessionId);
  }

  /** Picks the model (look) of the session's document. */
  async setModel(sessionId: string, body: unknown): Promise<CtStateDto> {
    const { modelId } = ctSessionModelSchema.parse(body);
    const session = await this.session(sessionId);
    this.deps.assertIdle(sessionId);
    if ((await this.deps.models.resolveId(modelId)) !== modelId) throw new NotFoundError('Modelo');
    await this.deps.repo.save({
      ...session,
      definition: {
        ...session.definition,
        ct: { ...(session.definition.ct ?? {}), modelId },
      },
      updatedAt: this.deps.clock.now(),
    });
    return this.state(sessionId);
  }

  /** HTML for the on-screen preview; images point at the app's authenticated image route. */
  async preview(sessionId: string): Promise<CtFile> {
    const { build, layout } = await this.load(sessionId);
    const doc = this.document(build);
    return {
      body: this.deps.renderers.previewHtml(doc, (key) => imageUrl(sessionId, key), layout),
      contentType: 'text/html; charset=utf-8',
      filename: null,
    };
  }

  async docx(sessionId: string): Promise<CtFile> {
    const { doc, images, layout } = await this.renderable(sessionId);
    const bytes = await this.guard(() => this.deps.renderers.docx(doc, images, layout));
    return {
      body: bytes,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${this.deps.renderers.fileStem(doc)}.docx`,
    };
  }

  async pdf(sessionId: string, signal?: AbortSignal): Promise<CtFile> {
    const { doc, images, layout } = await this.renderable(sessionId);
    try {
      const bytes = await this.guard(() => this.deps.renderers.pdf(doc, images, layout, signal));
      return {
        body: bytes,
        contentType: 'application/pdf',
        filename: `${this.deps.renderers.fileStem(doc)}.pdf`,
      };
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError(
        `Não foi possível gerar o PDF (${err instanceof Error ? err.message : 'erro desconhecido'}). Baixe o .docx ou confira o Chromium em Configurações.`,
        'ct_pdf_failed',
        503,
      );
    }
  }

  /** The "Plano de Teste" as an HTML fragment (`format: 'html'`) or plain text (`'text'`). */
  async clipboard(sessionId: string, format: 'html' | 'text'): Promise<CtFile> {
    const { doc, images, layout } = await this.renderable(sessionId);
    if (format === 'text') {
      return {
        body: ctPlanoPlainText(doc),
        contentType: 'text/plain; charset=utf-8',
        filename: null,
      };
    }
    return {
      body: await this.guard(async () => this.deps.renderers.clipboardHtml(doc, images, layout)),
      contentType: 'text/html; charset=utf-8',
      filename: null,
    };
  }

  /** Uploads the .docx as a NEW file of the connected OneDrive. */
  async publish(sessionId: string): Promise<CtOneDriveResultDto> {
    const publisher = this.deps.publisher;
    if (!publisher) {
      throw new DomainError('O OneDrive não está disponível.', 'ct_onedrive_unavailable', 503);
    }
    const { doc, images, layout } = await this.renderable(sessionId);
    const bytes = await this.guard(() => this.deps.renderers.docx(doc, images, layout));
    const fileName = publisher.suggestFileName({ ticketId: doc.ticketId, title: doc.title });
    return publisher.upload({ fileName, bytes });
  }

  private async renderable(sessionId: string) {
    const { build, images, layout } = await this.load(sessionId);
    return { doc: this.document(build), images, layout };
  }

  /** Renderer errors about unusable images become friendly pt-BR errors. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CtImageMissingError) {
        throw new DomainError(err.message, 'ct_image_missing', 422);
      }
      if (err instanceof Error && err.name === 'CtImageFormatError') {
        throw new DomainError(err.message, 'ct_image_format', 422);
      }
      throw err;
    }
  }
}
