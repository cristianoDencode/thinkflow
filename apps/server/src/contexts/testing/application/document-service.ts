import JSZip from 'jszip';
import { z } from 'zod';
import type { Clock } from '../../../shared/kernel/clock';
import { NotFoundError } from '../../../shared/kernel/errors';
import {
  buildEvidenceDocument,
  renderHtml,
  renderMarkdown,
  type DocImage,
  type EvidenceDocument,
} from '../domain/document';
import type { TestImageStore, TestSessionRepository } from '../domain/ports';
import { isFinishedRun } from '../domain/session';
import { generatePlaywrightSpec } from '../domain/spec';

export const documentQuerySchema = z.object({
  format: z.enum(['md', 'html', 'zip', 'spec']).default('html'),
  /** md: images embedded as data URIs (for the clipboard) instead of `imagens/…` paths. */
  inline: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

export interface DocumentFile {
  body: string | Uint8Array;
  contentType: string;
  /** Set for downloads. */
  filename: string | null;
}

export interface DocumentServiceDeps {
  repo: TestSessionRepository;
  images: TestImageStore;
  clock: Clock;
  /** pt-BR date/time (the server's time zone by default). */
  formatDate?: (ms: number) => string;
}

const defaultFormatDate = (ms: number) =>
  new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(ms);

/** File-name friendly version of the session name. */
export function slug(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'sessao-de-teste'
  );
}

export class DocumentService {
  constructor(private readonly deps: DocumentServiceDeps) {}

  private async load(sessionId: string) {
    const session = await this.deps.repo.find(sessionId);
    if (!session) throw new NotFoundError('Sessão de teste');
    const [evidences, runs] = await Promise.all([
      this.deps.repo.evidences(sessionId),
      this.deps.repo.runs(sessionId, 20),
    ]);
    const lastRun = runs.find((r) => isFinishedRun(r.status)) ?? null;
    const formatDate = this.deps.formatDate ?? defaultFormatDate;
    const doc = buildEvidenceDocument({
      session,
      evidences,
      lastRun,
      formatDate,
      now: this.deps.clock.now(),
    });
    return { session, doc: await this.withImages(doc), formatDate };
  }

  /** Reads every image once; images gone from the storage are left out of the document. */
  private async withImages(
    doc: EvidenceDocument,
  ): Promise<EvidenceDocument & { bytes: Map<string, Uint8Array> }> {
    const bytes = new Map<string, Uint8Array>();
    await Promise.all(
      doc.images.map(async (img) => {
        const data = await this.deps.images.get(img.key);
        if (data) bytes.set(img.key, data);
      }),
    );
    const has = (img: DocImage | null) => !!img && bytes.has(img.key);
    return {
      ...doc,
      steps: doc.steps.map((s) => (has(s.image) ? s : { ...s, image: null, imageComment: '' })),
      images: doc.images.filter((i) => has(i)),
      bytes,
    };
  }

  async render(sessionId: string, query: unknown): Promise<DocumentFile> {
    const { format, inline } = documentQuerySchema.parse(query);
    const { session, doc, formatDate } = await this.load(sessionId);
    const name = slug(session.name);
    const dataUri = (img: DocImage) =>
      `data:${img.mime};base64,${Buffer.from(doc.bytes.get(img.key)!).toString('base64')}`;

    switch (format) {
      case 'html':
        return {
          body: renderHtml(doc, dataUri),
          contentType: 'text/html; charset=utf-8',
          filename: null,
        };
      case 'md':
        return inline
          ? {
              body: renderMarkdown(doc, dataUri),
              contentType: 'text/markdown; charset=utf-8',
              filename: null,
            }
          : {
              body: renderMarkdown(doc, (img) => img.file),
              contentType: 'text/markdown; charset=utf-8',
              filename: `${name}.md`,
            };
      case 'zip': {
        const zip = new JSZip();
        zip.file(
          `${name}.md`,
          renderMarkdown(doc, (img) => img.file),
        );
        zip.file(
          `${name}.html`,
          renderHtml(doc, (img) => img.file),
        );
        for (const img of doc.images) zip.file(img.file, doc.bytes.get(img.key)!);
        const body = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        return { body, contentType: 'application/zip', filename: `${name}.zip` };
      }
      case 'spec':
        return {
          body: generatePlaywrightSpec(session, formatDate(this.deps.clock.now())),
          contentType: 'text/plain; charset=utf-8',
          filename: `${name}.spec.ts`,
        };
    }
  }
}
