import type {
  PrototypeBlockOutcome,
  PrototypeDecomposeOutcome,
  PrototypeFreeLayoutOutcome,
  PrototypeRenderer,
  PrototypeRenderOutcome,
} from '../../src/contexts/prototypes/domain/ports';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The head of a PNG (signature + IHDR sizes): enough for `pngSize` and the byte-for-byte checks. */
export function fakePng(width: number, height: number, tag = 0): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set(SIGNATURE, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[32] = tag;
  return bytes;
}

type RenderInput = Parameters<PrototypeRenderer['render']>[0];
type DecomposeInput = Parameters<PrototypeRenderer['decompose']>[0];
type BlockInput = Parameters<PrototypeRenderer['renderBlock']>[0];
type FreeLayoutInput = Parameters<PrototypeRenderer['freeLayout']>[0];

/** Records every call; the PNG has the requested size times the scale. */
export class FakePrototypeRenderer implements PrototypeRenderer {
  readonly calls: RenderInput[] = [];
  blockedRequests = 0;
  failWith: { error: string; unavailable: boolean } | null = null;
  readonly decomposeCalls: DecomposeInput[] = [];
  readonly blockCalls: BlockInput[] = [];
  readonly freeLayoutCalls: FreeLayoutInput[] = [];
  /** What `freeLayout` returns for a document; default: the body with one wrapper appended. */
  freeLayoutHtml: (document: string) => string = (document) => {
    const body = document.slice(document.indexOf('<body'));
    return body.replace(
      /<\/body>\s*$/i,
      '<div data-tf-free="1" style="position:absolute;left:10px;top:20px"><p>cópia</p></div></body>',
    );
  };
  /** `data-tf-layer` numbers the fake "does not see" (invisible components). */
  hiddenLayers = new Set<number>();

  /** The background is a full-size PNG; layer n sits at (10, 20·n) and measures 100×20. */
  async decompose(input: DecomposeInput): Promise<PrototypeDecomposeOutcome> {
    this.decomposeCalls.push(input);
    if (this.failWith) return { ok: false, ...this.failWith };
    const layers = Array.from({ length: input.layerCount }, (_, i) => i + 1)
      .filter((n) => !this.hiddenLayers.has(n))
      .map((n) => ({
        n,
        x: 10,
        y: 20 * n,
        width: 100,
        height: 20,
        png: fakePng(100 * input.scale, 20 * input.scale, n),
      }));
    return {
      ok: true,
      background: fakePng(input.width * input.scale, input.height * input.scale, 200),
      layers,
    };
  }

  async freeLayout(input: FreeLayoutInput): Promise<PrototypeFreeLayoutOutcome> {
    this.freeLayoutCalls.push(input);
    if (this.failWith) return { ok: false, ...this.failWith };
    return { ok: true, html: this.freeLayoutHtml(input.document) };
  }

  async renderBlock(input: BlockInput): Promise<PrototypeBlockOutcome> {
    this.blockCalls.push(input);
    if (this.failWith) return { ok: false, ...this.failWith };
    return { ok: true, png: fakePng(150, 24, this.blockCalls.length), width: 150, height: 24 };
  }

  async render(input: RenderInput): Promise<PrototypeRenderOutcome> {
    this.calls.push(input);
    if (this.failWith) return { ok: false, ...this.failWith };
    const width = input.width * input.scale;
    const height = input.height * input.scale;
    return {
      ok: true,
      png: fakePng(width, height, this.calls.length),
      width,
      height,
      blockedRequests: this.blockedRequests,
    };
  }
}

const UNAVAILABLE = {
  ok: false,
  error: 'Chromium não encontrado; instale o Playwright',
  unavailable: true,
} as const;

export class UnavailablePrototypeRenderer implements PrototypeRenderer {
  async freeLayout(): Promise<PrototypeFreeLayoutOutcome> {
    return UNAVAILABLE;
  }

  async decompose(): Promise<PrototypeDecomposeOutcome> {
    return UNAVAILABLE;
  }

  async renderBlock(): Promise<PrototypeBlockOutcome> {
    return UNAVAILABLE;
  }

  async render(): Promise<PrototypeRenderOutcome> {
    return {
      ok: false,
      error: 'Chromium não encontrado; instale o Playwright',
      unavailable: true,
    };
  }
}
