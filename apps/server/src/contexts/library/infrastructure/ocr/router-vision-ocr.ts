import { ExtractionError } from '../../domain/library';
import type { OcrEngine } from '../../domain/ports';
import { convertStream, tapUsage, type UsageTotals } from '../../../protocol/domain/convert';
import type { OAIChunk } from '../../../protocol/domain/wire-types';
import type { RouteChatRequest } from '../../../routing/application/route-chat-request';

export const VISION_OCR_PROMPT =
  'Transcreva fielmente todo o texto da imagem, preservando títulos, listas e tabelas em Markdown. Não resuma nem comente. Se não houver texto, responda exatamente: (sem texto).';
const NO_TEXT_RE = /^\(?\s*sem texto\s*\)?\.?$/i;
const VISION_TIMEOUT_MS = 90_000;
const VISION_MAX_OUTPUT_TOKENS = 4000;

export interface RouterVisionOcrDeps {
  router: RouteChatRequest;
  /** Configured vision model; '' means "let the router pick" (auto). */
  model: () => string;
}

/**
 * OCR through a vision-capable model reachable by the router (opt-in: the image leaves the server
 * and consumes provider quota). The router records the usage under the `library-ocr` source.
 */
export class RouterVisionOcr implements OcrEngine {
  readonly method = 'ocr-vision' as const;

  constructor(private readonly deps: RouterVisionOcrDeps) {}

  async recognize(image: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(VISION_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const dataUrl = `data:${mime};base64,${Buffer.from(image).toString('base64')}`;
    const routed = await this.deps.router.execute(
      {
        format: 'openai',
        body: {
          model: this.deps.model().trim() || 'auto',
          stream: true,
          temperature: 0,
          max_tokens: VISION_MAX_OUTPUT_TOKENS,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: VISION_OCR_PROMPT },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        },
      },
      { source: 'library-ocr', signal: combined },
    );
    if (!routed.ok) throw new ExtractionError(`OCR por IA indisponível: ${routed.message}`);

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
      throw err;
    }
    const trimmed = text.trim();
    return NO_TEXT_RE.test(trimmed) ? '' : trimmed;
  }
}
