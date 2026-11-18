import mammoth from 'mammoth';
import { ExtractionError, type ExtractedSection } from '../../domain/library';

/** DOCX body text via mammoth (raw text: paragraphs separated by blank lines). */
export async function extractDocx(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ sections: ExtractedSection[]; warnings: string[] }> {
  let result: { value: string; messages: { message: string }[] };
  try {
    const work = mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    result = signal
      ? await Promise.race([
          work,
          new Promise<never>((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          ),
        ])
      : await work;
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ExtractionError('Arquivo DOCX inválido ou corrompido');
  }
  return {
    sections: result.value.trim() ? [{ text: result.value }] : [],
    warnings: result.messages.map((m) => m.message),
  };
}
