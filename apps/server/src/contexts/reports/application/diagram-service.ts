import {
  diagramRepairSchema,
  hashDiagram,
  normalizeDiagrams,
  type DiagramRepairResultDto,
} from '@thinkflow/shared';
import { convertStream, tapUsage, type UsageTotals } from '../../protocol/domain/convert';
import type { OAIChunk } from '../../protocol/domain/wire-types';
import type { RouteChatRequest } from '../../routing/application/route-chat-request';
import { DomainError } from '../../../shared/kernel/errors';
import {
  RepairRateLimiter,
  buildDiagramRepairMessages,
  extractRepairedDiagram,
} from '../domain/diagram-repair';
import { mapMermaidFences, mermaidCodes } from '../domain/mermaid-blocks';
import type { DiagramRenderer } from '../domain/render-ports';
import { isSafeSvg } from '../domain/svg-guard';

/** Per section: more diagrams than this are left unvalidated. */
export const MAX_DIAGRAMS_PER_SECTION = 20;
const MAX_DIAGRAM_CHARS = 8_000;
const SVG_CACHE_SIZE = 300;

const REPAIR_TIMEOUT_MS = 60_000;
const REPAIR_MAX_OUTPUT_TOKENS = 1_500;

export interface DiagramServiceDeps {
  router: RouteChatRequest;
  /** Configured repair model (`reportSettings.repairModel`, then the history summary model); '' = use the request's model. */
  repairModel: () => string;
  /** Called after a repair attempt so the chat can cache it in the message meta. */
  onRepaired?: (messageId: string, hash: string, code: string | null) => Promise<void>;
  now: () => number;
  limiter?: RepairRateLimiter;
  /** Server-side Mermaid validation (Chromium); without it diagrams stay unvalidated. */
  renderer?: DiagramRenderer;
}

export interface PrepareOptions {
  /** Model of the report (the repair falls back to it). */
  model: string;
  signal?: AbortSignal;
  /** Where the diagrams are, for warnings, e.g. `seção "Fluxo"`. */
  label: string;
}

export interface PreparedDiagrams {
  markdown: string;
  /** Diagrams whose syntax the model had to repair. */
  repaired: number;
  warnings: string[];
}

export interface RenderedDiagrams {
  /** Safe SVG by `hashDiagram(code)`. */
  svgByHash: Record<string, string>;
  total: number;
  rendered: number;
  failed: number;
  unvalidated: number;
}

export class DiagramService {
  private readonly limiter: RepairRateLimiter;
  private readonly svgCache = new Map<string, string>();

  constructor(private readonly deps: DiagramServiceDeps) {
    this.limiter = deps.limiter ?? new RepairRateLimiter();
  }

  /** One LLM round-trip that fixes the syntax of a chat diagram (recorded as `diagram-repair`). */
  async repairForChat(input: unknown, signal?: AbortSignal): Promise<DiagramRepairResultDto> {
    const request = diagramRepairSchema.parse(input);
    if (!this.limiter.tryTake(this.deps.now())) {
      throw new DomainError(
        'Muitas correções de diagrama em pouco tempo; tente novamente em instantes.',
        'diagram_repair_limit',
        429,
      );
    }
    const code = await this.callModel(request.code, request.error, request.model, signal);
    if (request.messageId && this.deps.onRepaired) {
      await this.deps
        .onRepaired(request.messageId, hashDiagram(request.code), code)
        .catch(() => undefined);
    }
    return { code, repaired: code !== null };
  }

  /**
   * Validates every Mermaid diagram of a section with the real renderer. A diagram that fails
   * gets ONE repair round-trip to the model; if it still fails the code stays as it is (the
   * viewer shows it as a code block) and a warning is returned. Without a renderer nothing is
   * validated and the Markdown is only normalized.
   */
  async prepare(markdown: string, options: PrepareOptions): Promise<PreparedDiagrams> {
    const normalized = normalizeDiagrams(markdown).text;
    const renderer = this.deps.renderer;
    const codes = [...new Set(mermaidCodes(normalized))];
    const result: PreparedDiagrams = { markdown: normalized, repaired: 0, warnings: [] };
    if (!renderer || codes.length === 0) return result;
    if (!(await renderer.status().catch(() => ({ available: false }))).available) return result;

    const replacements = new Map<string, string>();
    for (const [i, code] of codes.slice(0, MAX_DIAGRAMS_PER_SECTION).entries()) {
      if (options.signal?.aborted) break;
      if (code.length > MAX_DIAGRAM_CHARS) continue;
      const first = await this.tryRender(code, options.signal);
      if (first.kind !== 'error') continue; // rendered, or the renderer is unavailable
      const repaired = await this.callModel(code, first.error, options.model, options.signal);
      if (repaired) {
        const second = await this.tryRender(repaired, options.signal);
        if (second.kind === 'ok') {
          replacements.set(code, repaired);
          result.repaired += 1;
          continue;
        }
      }
      result.warnings.push(
        `Diagrama ${i + 1} (${options.label}) não pôde ser validado; o código foi mantido.`,
      );
    }
    if (replacements.size > 0)
      result.markdown = mapMermaidFences(
        normalized,
        (code) => replacements.get(code) ?? null,
      ).markdown;
    return result;
  }

  /** Renders every distinct diagram of the document (cache first); used when assembling. */
  async renderAll(markdown: string, signal?: AbortSignal): Promise<RenderedDiagrams> {
    const codes = mermaidCodes(markdown);
    const out: RenderedDiagrams = {
      svgByHash: {},
      total: codes.length,
      rendered: 0,
      failed: 0,
      unvalidated: 0,
    };
    const renderer = this.deps.renderer;
    // asking for the status may start the browser: only when there is something to render
    const available =
      codes.length > 0 &&
      !!renderer &&
      (await renderer.status().catch(() => ({ available: false }))).available;
    const state = new Map<string, 'ok' | 'error' | 'unavailable'>();
    for (const code of codes) {
      const hash = hashDiagram(code);
      let kind = state.get(hash);
      if (!kind) {
        if (!available || code.length > MAX_DIAGRAM_CHARS || signal?.aborted) kind = 'unavailable';
        else kind = (await this.tryRender(code, signal)).kind;
        state.set(hash, kind);
      }
      const svg = this.svgCache.get(hash);
      if (kind === 'ok' && svg) {
        out.svgByHash[hash] = svg;
        out.rendered += 1;
      } else if (kind === 'error') out.failed += 1;
      else out.unvalidated += 1;
    }
    return out;
  }

  private async tryRender(
    code: string,
    signal?: AbortSignal,
  ): Promise<{ kind: 'ok' } | { kind: 'error'; error: string } | { kind: 'unavailable' }> {
    const hash = hashDiagram(code);
    if (this.svgCache.has(hash)) return { kind: 'ok' };
    const renderer = this.deps.renderer;
    if (!renderer) return { kind: 'unavailable' };
    const res = await renderer.render(code, signal).catch(
      (err: unknown) =>
        ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          unavailable: true,
        }) as const,
    );
    if (res.ok) {
      if (!isSafeSvg(res.svg)) return { kind: 'unavailable' };
      this.svgCache.set(hash, res.svg);
      if (this.svgCache.size > SVG_CACHE_SIZE) {
        const oldest = this.svgCache.keys().next().value;
        if (oldest !== undefined) this.svgCache.delete(oldest);
      }
      return { kind: 'ok' };
    }
    return res.unavailable ? { kind: 'unavailable' } : { kind: 'error', error: res.error };
  }

  private async callModel(
    code: string,
    error: string,
    requestModel: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const timeout = AbortSignal.timeout(REPAIR_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const routed = await this.deps.router.execute(
        {
          format: 'openai',
          body: {
            model: this.deps.repairModel().trim() || requestModel,
            messages: buildDiagramRepairMessages(code, error),
            stream: true,
            max_tokens: REPAIR_MAX_OUTPUT_TOKENS,
            temperature: 0,
          },
        },
        { source: 'diagram-repair', signal: combined },
      );
      if (!routed.ok) return null;
      const usage: UsageTotals = { inputTokens: null, outputTokens: null };
      let text = '';
      try {
        const chunks = tapUsage(
          convertStream(routed.stream.events, routed.stream.format, 'openai', routed.model),
          'openai',
          usage,
        );
        for await (const raw of chunks) {
          const delta = (raw as unknown as OAIChunk).choices?.[0]?.delta;
          if (delta?.content) text += delta.content;
        }
        routed.finish(usage);
      } catch (err) {
        routed.finish({ ...usage, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
      const repaired = extractRepairedDiagram(text);
      return repaired && repaired.trim() !== code.trim() ? repaired : null;
    } catch {
      return null;
    }
  }
}
