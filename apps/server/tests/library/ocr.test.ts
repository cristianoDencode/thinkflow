import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtractionError } from '../../src/contexts/library/domain/library';
import type { LibraryUsageRecorder, OcrEngine } from '../../src/contexts/library/domain/ports';
import { CompositeExtractor } from '../../src/contexts/library/infrastructure/extractors/composite-extractor';
import { recognizeWithFallback } from '../../src/contexts/library/infrastructure/extractors/ocr-selection';
import {
  installPackagedLanguages,
  TesseractOcr,
  type TesseractWorkerLike,
} from '../../src/contexts/library/infrastructure/ocr/tesseract-ocr';
import { makePdf, PNG_1X1 } from './library-fixtures';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-ocr-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeWorkerFactory(texts: string[] = ['texto reconhecido']) {
  const created: { langs: string; terminated: boolean; calls: number }[] = [];
  let active = 0;
  let maxActive = 0;
  const factory = async (langs: string): Promise<TesseractWorkerLike> => {
    const state = { langs, terminated: false, calls: 0 };
    created.push(state);
    return {
      recognize: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { data: { text: texts[state.calls++ % texts.length]! } };
      },
      terminate: async () => {
        state.terminated = true;
      },
    };
  };
  return { factory, created, maxActive: () => maxActive };
}

describe('TesseractOcr', () => {
  it('creates the worker lazily, reuses it, serializes jobs and terminates it', async () => {
    const fake = fakeWorkerFactory(['um', 'dois', 'três']);
    const records: Parameters<LibraryUsageRecorder['record']>[0][] = [];
    const ocr = new TesseractOcr({
      tessdataDir: tmp(),
      languages: () => 'por+eng',
      usage: { record: (e) => records.push(e) },
      createWorker: fake.factory,
    });
    expect(fake.created).toHaveLength(0);

    const results = await Promise.all([
      ocr.recognize(PNG_1X1, 'image/png'),
      ocr.recognize(PNG_1X1, 'image/png'),
      ocr.recognize(PNG_1X1, 'image/png'),
    ]);
    expect(results).toEqual(['um', 'dois', 'três']);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.langs).toBe('por+eng');
    expect(fake.maxActive()).toBe(1);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      source: 'library-ocr',
      providerId: 'tesseract',
      model: 'por+eng',
      success: true,
      inputTokens: 0,
    });

    await ocr.terminate();
    expect(fake.created[0]!.terminated).toBe(true);
    await expect(ocr.recognize(PNG_1X1, 'image/png')).rejects.toBeInstanceOf(ExtractionError);
  });

  it('rebuilds the worker when the configured languages change', async () => {
    const fake = fakeWorkerFactory();
    let langs = 'por';
    const ocr = new TesseractOcr({
      tessdataDir: tmp(),
      languages: () => langs,
      createWorker: fake.factory,
    });
    await ocr.recognize(PNG_1X1, 'image/png');
    langs = 'eng';
    await ocr.recognize(PNG_1X1, 'image/png');
    expect(fake.created.map((w) => w.langs)).toEqual(['por', 'eng']);
    expect(fake.created[0]!.terminated).toBe(true);
    await ocr.terminate();
  });

  it('drops the worker and records a failure when a job is aborted', async () => {
    const records: Parameters<LibraryUsageRecorder['record']>[0][] = [];
    const created: { terminated: boolean }[] = [];
    const ocr = new TesseractOcr({
      tessdataDir: tmp(),
      languages: () => 'eng',
      usage: { record: (e) => records.push(e) },
      createWorker: async () => {
        const state = { terminated: false };
        created.push(state);
        return {
          recognize: () => new Promise(() => undefined), // never settles
          terminate: async () => {
            state.terminated = true;
          },
        };
      },
    });
    const controller = new AbortController();
    const pending = ocr.recognize(PNG_1X1, 'image/png', controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeDefined();
    expect(created[0]!.terminated).toBe(true);
    expect(records[0]).toMatchObject({ success: false });
    await ocr.terminate();
  });

  it('turns worker start-up failures into a friendly message', async () => {
    const ocr = new TesseractOcr({
      tessdataDir: tmp(),
      languages: () => 'xyz',
      createWorker: async () => {
        throw new Error('network down');
      },
    });
    await expect(ocr.recognize(PNG_1X1, 'image/png')).rejects.toThrow(/idiomas do OCR \(xyz\)/);
    await ocr.terminate();
  });
});

describe('offline language data', () => {
  it('installs the packaged por/eng models and leaves unknown languages to tesseract.js', async () => {
    const dir = tmp();
    const available = await installPackagedLanguages('por+eng+xyz', dir);
    expect([...available].sort()).toEqual(['eng', 'por']);
    for (const lang of ['por', 'eng']) {
      const file = path.join(dir, `${lang}.traineddata`);
      expect(fs.statSync(file).size).toBeGreaterThan(1_000_000);
    }
    expect(fs.existsSync(path.join(dir, 'xyz.traineddata'))).toBe(false);
  });
});

describe('recognizeWithFallback', () => {
  const engine = (method: OcrEngine['method'], run: () => Promise<string>): OcrEngine => ({
    method,
    recognize: run,
  });

  it('falls back to the second engine and warns', async () => {
    const warnings: string[] = [];
    const out = await recognizeWithFallback(
      {
        primary: engine('ocr-vision', async () => {
          throw new Error('boom');
        }),
        fallback: engine('ocr-local', async () => 'local'),
        onWarning: (m) => warnings.push(m),
      },
      PNG_1X1,
      'image/png',
    );
    expect(out).toEqual({ text: 'local', method: 'ocr-local' });
    expect(warnings[0]).toMatch(/boom/);
  });

  it('does not fall back when aborted, nor without a fallback', async () => {
    const controller = new AbortController();
    controller.abort();
    const failing = engine('ocr-vision', async () => {
      throw new Error('boom');
    });
    await expect(
      recognizeWithFallback(
        { primary: failing, fallback: engine('ocr-local', async () => 'x') },
        PNG_1X1,
        'image/png',
        controller.signal,
      ),
    ).rejects.toBeDefined();
    await expect(recognizeWithFallback({ primary: failing }, PNG_1X1, 'image/png')).rejects.toThrow(
      'boom',
    );
  });
});

describe('scanned PDFs (L5b)', () => {
  const fakeOcr = (): OcrEngine & { calls: number } => ({
    method: 'ocr-local',
    calls: 0,
    async recognize() {
      this.calls++;
      return `Texto da página ${this.calls}`;
    },
  });
  const extract = (ocr: CompositeExtractor, bytes: Uint8Array) =>
    ocr.extract({ bytes, kind: 'pdf', name: 'scan.pdf' }, {});

  it('renders pages with no text layer and OCRs them (real canvas rendering)', async () => {
    const ocr = fakeOcr();
    const warnings: string[] = [];
    const extractor = new CompositeExtractor({
      ocr: () => ocr,
      onWarning: (m) => warnings.push(m),
    });
    const out = await extract(extractor, await makePdf(['', '', '']));
    expect(out.method).toBe('ocr-local');
    expect(out.pageCount).toBe(3);
    expect(out.sections.map((s) => [s.page, s.text])).toEqual([
      [1, 'Texto da página 1'],
      [2, 'Texto da página 2'],
      [3, 'Texto da página 3'],
    ]);
    expect(warnings).toEqual([]);
  });

  it('passes a PNG to the engine', async () => {
    const seen: Uint8Array[] = [];
    const extractor = new CompositeExtractor({
      ocr: () => ({
        method: 'ocr-local',
        recognize: async (image) => {
          seen.push(image);
          return 'ok';
        },
      }),
    });
    await extract(extractor, await makePdf(['']));
    expect(Buffer.from(seen[0]!.subarray(0, 4)).toString('hex')).toBe('89504e47');
  });

  it('keeps native text and only OCRs the pages that need it', async () => {
    const ocr = fakeOcr();
    const extractor = new CompositeExtractor({ ocr: () => ocr });
    // 1 of 3 blank pages is not "scanned": the heuristic needs more than half
    const mixed = await extract(
      extractor,
      await makePdf(['Capa com bastante texto nativo', '', 'Terceira página com texto nativo']),
    );
    expect(mixed.method).toBe('text');
    expect(ocr.calls).toBe(0);

    const scanned = await extract(
      extractor,
      await makePdf(['', '', 'Página com texto nativo suficiente']),
    );
    expect(scanned.method).toBe('ocr-local');
    expect(ocr.calls).toBe(2);
    expect(scanned.sections.map((s) => s.page)).toEqual([1, 2, 3]);
    expect(scanned.sections[2]!.text).toContain('texto nativo suficiente');
  });

  it('does not OCR when OCR is off', async () => {
    const out = await extract(new CompositeExtractor(), await makePdf(['', '']));
    expect(out.sections).toEqual([]);
    expect(out.method).toBe('text');
  });

  it('caps the pages at 30 and warns', async () => {
    const ocr = fakeOcr();
    const warnings: string[] = [];
    const extractor = new CompositeExtractor({
      ocr: () => ocr,
      onWarning: (m) => warnings.push(m),
      pdfOcr: { renderer: async () => PNG_1X1, canvasAvailable: async () => true },
    });
    const out = await extract(extractor, await makePdf(Array.from({ length: 35 }, () => '')));
    expect(ocr.calls).toBe(30);
    expect(out.sections).toHaveLength(30);
    expect(out.pageCount).toBe(35);
    expect(warnings.join(' ')).toMatch(/primeiras 30 páginas digitalizadas de 35/);
  });

  it('degrades gracefully when the canvas module is unavailable', async () => {
    const extractor = new CompositeExtractor({
      ocr: () => fakeOcr(),
      pdfOcr: { canvasAvailable: async () => false },
    });
    await expect(extract(extractor, await makePdf(['', '']))).rejects.toThrow(
      'OCR de PDF digitalizado indisponível neste servidor',
    );
    // with text already extracted, the text is kept and only a warning is reported
    const warnings: string[] = [];
    const lenient = new CompositeExtractor({
      ocr: () => fakeOcr(),
      onWarning: (m) => warnings.push(m),
      pdfOcr: { canvasAvailable: async () => false },
    });
    const out = await extract(
      lenient,
      await makePdf(['', '', 'Texto nativo suficientemente longo']),
    );
    expect(out.method).toBe('text');
    expect(out.sections).toHaveLength(1);
    expect(warnings.join(' ')).toMatch(/indisponível/);
  });

  it('reports unavailable when every page fails to render', async () => {
    const extractor = new CompositeExtractor({
      ocr: () => fakeOcr(),
      pdfOcr: {
        canvasAvailable: async () => true,
        renderer: async () => {
          throw new Error('render');
        },
      },
    });
    await expect(extract(extractor, await makePdf(['', '']))).rejects.toThrow(/indisponível/);
  });
});

// Optional: exercises the real tesseract.js worker. Slow, so it is opt-in (RUN_OCR_TESTS=1).
describe.skipIf(!process.env.RUN_OCR_TESTS)('real Tesseract (smoke)', () => {
  it('recognizes text rendered into a PNG', async () => {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(900, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 900, 200);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 72px sans-serif';
    ctx.fillText('Prazo de 10 dias', 40, 120);
    const png = new Uint8Array(await canvas.encode('png'));

    const ocr = new TesseractOcr({ tessdataDir: tmp(), languages: () => 'por+eng' });
    try {
      const text = await ocr.recognize(png, 'image/png');
      expect(text).toMatch(/prazo/i);
      expect(text).toMatch(/10/);
    } finally {
      await ocr.terminate();
    }
  }, 120_000);
});
