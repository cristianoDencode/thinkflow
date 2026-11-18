import type {
  DiagramRenderer,
  DiagramRenderResult,
  PdfRenderer,
  RendererStatus,
} from '../domain/render-ports';

export const NO_RENDERER_REASON =
  'Chromium não encontrado; rode `pnpm --filter @thinkflow/web exec playwright install chromium` (ou informe o caminho em Ajustes).';

/** Used when Chromium is missing (degraded mode) and as the default in tests. */
export class UnavailableRenderer implements DiagramRenderer, PdfRenderer {
  constructor(private readonly reason: string = NO_RENDERER_REASON) {}

  async status(): Promise<RendererStatus> {
    return { available: false, reason: this.reason, executablePath: null };
  }

  async render(): Promise<DiagramRenderResult> {
    return { ok: false, error: this.reason, unavailable: true };
  }

  async pdf(): Promise<Uint8Array> {
    throw new Error(this.reason);
  }
}
