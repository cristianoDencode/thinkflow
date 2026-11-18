import {
  ECIDADE_COMPONENT_KINDS,
  EC_KIND_ATTR,
  EC_PART_ATTR,
  SCENE_CONTAINER_KINDS,
  SCENE_LIMITS,
  type EcidadeComponentKind,
  type PrototypeScene,
  type SceneLayer,
} from '@thinkflow/shared';
import {
  decodeEntities,
  getAttr,
  parseHtml,
  removeAttr,
  serializeNodes,
  setAttr,
  textContent,
  type HtmlElement,
  type HtmlNode,
} from './html-tree';
import { renderDocument } from './prototype';

/*
 * "Modo Livre" (scene) helpers, all pure: marking the e-Cidade components that become layers,
 * naming them, and turning a scene back into the HTML Chromium renders.
 */

/** Marker the decomposition puts on the root of every component that becomes a layer. */
export const LAYER_MARK_ATTR = 'data-tf-layer';

/**
 * Extra marker of the layers that are containers (fieldset/tabs): its value is the nesting depth
 * among container layers (0 = outermost). Leaf layers do not carry it.
 */
export const CONTAINER_MARK_ATTR = 'data-tf-container';

/** Line height of text layers (Konva's default), so the editor and the render agree. */
export const SCENE_TEXT_LINE_HEIGHT = 1.2;

export interface MarkedLayer {
  /** The value of `data-tf-layer` (1-based, document order). */
  n: number;
  /** The e-Cidade kind (loose controls get the closest one; a loose `<img>` is 'image'). */
  kind: EcidadeComponentKind | 'image';
  /** "Lookup: Reduzido", "Barra de botões"… */
  name: string;
}

const KIND_NAME: Record<EcidadeComponentKind, string> = {
  'window-title': 'Título de janela',
  'status-bar': 'Barra de status',
  fieldset: 'Grupo',
  field: 'Campo',
  lookup: 'Lookup',
  date: 'Data',
  'date-range': 'Data (intervalo)',
  select: 'Combo',
  textarea: 'Área de texto',
  checkbox: 'Caixa de seleção',
  'radio-group': 'Grupo de opções',
  button: 'Botão',
  'button-bar': 'Barra de botões',
  grid: 'Grade',
  tabs: 'Abas',
  message: 'Mensagem',
};

/** Which part carries the "main text" of a kind (default: the label); none = the kind name only. */
const NAME_PART: Partial<Record<EcidadeComponentKind, string | null>> = {
  'window-title': 'title',
  button: 'button',
  message: 'text',
  'status-bar': null,
  'button-bar': null,
  grid: null,
  tabs: null,
  fieldset: 'legend',
};

const KINDS = new Set<string>(ECIDADE_COMPONENT_KINDS);

const kindOf = (el: HtmlElement): EcidadeComponentKind | null => {
  const raw = getAttr(el, EC_KIND_ATTR);
  return raw !== null && KINDS.has(raw) ? (raw as EcidadeComponentKind) : null;
};

/** Whitespace collapsed, decoded, trailing ":" dropped, clipped. */
const cleanText = (raw: string, max = 40): string => {
  const text = decodeEntities(raw)
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/[\s:]+$/, '')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const findPart = (el: HtmlElement, part: string): HtmlElement | null => {
  for (const child of el.children) {
    if (child.type !== 'element') continue;
    if (getAttr(child, EC_PART_ATTR) === part) return child;
    const deeper = findPart(child, part);
    if (deeper) return deeper;
  }
  return null;
};

/** Visible text of a part: its text, or the `value`/`title` of a button-like control. */
const partText = (part: HtmlElement): string => {
  const text = cleanText(textContent(part));
  if (text) return text;
  const own = getAttr(part, 'value') ?? getAttr(part, 'title') ?? '';
  return cleanText(own);
};

/** "Lookup: Reduzido", "Data (intervalo): Data Emissão", "Barra de botões". */
export function layerNameOf(el: HtmlElement, kind: EcidadeComponentKind): string {
  const base = KIND_NAME[kind];
  const wanted = kind in NAME_PART ? NAME_PART[kind] : 'label';
  if (!wanted) return base;
  const part = findPart(el, wanted) ?? (kind === 'button' || kind === 'message' ? el : null);
  const text = part ? partText(part) : '';
  return text ? `${base}: ${text}`.slice(0, SCENE_LIMITS.maxNameLength) : base;
}

const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image']);

/**
 * A form control or image that is not part of any recognized component: its kind and name, or
 * null when it is not one (or is a hidden input).
 */
function looseLayerOf(el: HtmlElement): { kind: MarkedLayer['kind']; name: string } | null {
  const max = SCENE_LIMITS.maxNameLength;
  const named = (base: string, text: string) => (text ? `${base}: ${text}`.slice(0, max) : base);
  switch (el.tag) {
    case 'button':
      return {
        kind: 'button',
        name: named(KIND_NAME.button, cleanText(textContent(el)) || partText(el)),
      };
    case 'select':
      return { kind: 'select', name: 'Lista' };
    case 'textarea':
      return { kind: 'textarea', name: KIND_NAME.textarea };
    // loose `<img>`s are decoration (window-control icons drawn over the title bar, logos): they
    // stay in whatever layer/background covers them — as their own layers they would sit under
    // the title bar image that already contains them
    case 'input': {
      const type = (getAttr(el, 'type') ?? 'text').trim().toLowerCase();
      if (type === 'hidden') return null;
      if (BUTTON_INPUT_TYPES.has(type)) {
        return { kind: 'button', name: named(KIND_NAME.button, partText(el)) };
      }
      if (type === 'checkbox') return { kind: 'checkbox', name: KIND_NAME.checkbox };
      if (type === 'radio') return { kind: 'radio-group', name: 'Opção' };
      return { kind: 'field', name: KIND_NAME.field };
    }
    default:
      return null;
  }
}

/**
 * Marks the layer roots of a stored screen with `data-tf-layer="<n>"` (1-based, document order, so
 * a container comes before everything inside it):
 * - the OUTERMOST recognized components that are not containers (a component inside another leaf
 *   is just a part of it);
 * - recognized containers (fieldset/tabs), also nested ones: they carry `data-tf-container="<depth>"`
 *   and their layer image shows the container WITHOUT its descendant layers;
 * - loose controls (`button`, `input`, `select`, `textarea`, `img`) that are inside no leaf layer.
 * Stale marks are removed. At most `SCENE_LIMITS.maxLayers` layers are marked.
 */
export function markSceneLayers(html: string): { html: string; layers: MarkedLayer[] } {
  const tree = parseHtml(html);
  const layers: MarkedLayer[] = [];
  const mark = (node: HtmlElement, kind: MarkedLayer['kind'], name: string): boolean => {
    if (layers.length >= SCENE_LIMITS.maxLayers) return false;
    const n = layers.length + 1;
    setAttr(node, LAYER_MARK_ATTR, String(n));
    layers.push({ n, kind, name });
    return true;
  };
  const walk = (nodes: readonly HtmlNode[], depth: number) => {
    for (const node of nodes) {
      if (node.type !== 'element') continue;
      removeAttr(node, LAYER_MARK_ATTR);
      removeAttr(node, CONTAINER_MARK_ATTR);
      const kind = kindOf(node);
      if (kind && SCENE_CONTAINER_KINDS.has(kind)) {
        const marked = mark(node, kind, layerNameOf(node, kind));
        if (marked) setAttr(node, CONTAINER_MARK_ATTR, String(depth));
        walk(node.children, marked ? depth + 1 : depth);
        continue;
      }
      if (kind) {
        mark(node, kind, layerNameOf(node, kind));
        stripMarks(node.children);
        continue; // everything inside belongs to this layer
      }
      const loose = looseLayerOf(node);
      if (loose) {
        mark(node, loose.kind, loose.name);
        stripMarks(node.children);
        continue;
      }
      walk(node.children, depth);
    }
  };
  const stripMarks = (nodes: readonly HtmlNode[]) => {
    for (const node of nodes) {
      if (node.type !== 'element') continue;
      removeAttr(node, LAYER_MARK_ATTR);
      removeAttr(node, CONTAINER_MARK_ATTR);
      stripMarks(node.children);
    }
  };
  walk(tree, 0);
  return { html: serializeNodes(tree), layers };
}

/* ------------------------------ scene -> HTML ------------------------------ */

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Numbers in CSS: at most two decimals, never exponent notation. */
const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

const SAFE_COLOR = /^[#a-zA-Z0-9(),.%\s-]+$/;
const SAFE_FONT = /^[\w\s,\-'"]+$/;
const FORBIDDEN = /url|expression|var\(|@|\\/i;

/** A CSS value that cannot break out of the declaration; otherwise the fallback. */
const safeColor = (value: string | undefined, fallback: string): string =>
  value && SAFE_COLOR.test(value) && !FORBIDDEN.test(value) ? value : fallback;
const safeFont = (value: string): string =>
  SAFE_FONT.test(value) && !FORBIDDEN.test(value) ? value : 'Arial, Helvetica, sans-serif';

function layerHtml(layer: SceneLayer, assets: ReadonlyMap<string, string>): string {
  const box = `position:absolute;left:${px(layer.x)};top:${px(layer.y)};width:${px(layer.width)};height:${px(layer.height)}`;
  if (layer.type === 'image') {
    const uri = layer.image ? assets.get(layer.image.asset) : undefined;
    if (!uri) return '';
    return `<img src="${escapeHtml(uri)}" alt="" style="${box};display:block">`;
  }
  if (layer.type === 'text' && layer.text) {
    const t = layer.text;
    const style = [
      box,
      `font-size:${px(t.fontSize)}`,
      `font-family:${safeFont(t.fontFamily)}`,
      `color:${safeColor(t.color, '#000000')}`,
      `font-weight:${t.bold ? 'bold' : 'normal'}`,
      `text-align:${t.align}`,
      `line-height:${SCENE_TEXT_LINE_HEIGHT}`,
      'white-space:pre-wrap',
      'overflow-wrap:break-word',
    ].join(';');
    return `<div style="${escapeHtml(style)}">${escapeHtml(t.value)}</div>`;
  }
  if (layer.type === 'rect' && layer.rect) {
    const r = layer.rect;
    const style = [box, 'box-sizing:border-box', `background:${safeColor(r.fill, '#e0e0e0')}`];
    if (r.stroke && (r.strokeWidth ?? 1) > 0) {
      style.push(`border:${px(r.strokeWidth ?? 1)} solid ${safeColor(r.stroke, '#000000')}`);
    }
    if (r.radius) style.push(`border-radius:${px(r.radius)}`);
    return `<div style="${escapeHtml(style.join(';'))}"></div>`;
  }
  return '';
}

/**
 * The page Chromium renders for a scene: a `width`×`height` body with the background image at 0,0
 * and every VISIBLE layer on top, in order, absolutely positioned. `assets` maps an asset id to its
 * `data:` URI (a layer whose asset is missing is left out). No network is ever needed.
 */
export function sceneToHtml(
  scene: PrototypeScene,
  size: { width: number; height: number },
  assets: ReadonlyMap<string, string>,
): string {
  const parts: string[] = [];
  const background = scene.background ? assets.get(scene.background.asset) : undefined;
  if (background) {
    parts.push(
      `<img src="${escapeHtml(background)}" alt="" style="position:absolute;left:0;top:0;width:${px(size.width)};height:${px(size.height)};display:block">`,
    );
  }
  for (const layer of scene.layers) {
    if (layer.visible) parts.push(layerHtml(layer, assets));
  }
  const body = `<body style="margin:0;width:${px(size.width)};height:${px(size.height)};position:relative;overflow:hidden;background:#fff">${parts.join('')}</body>`;
  return renderDocument(body, '');
}

/** Every asset a scene refers to (background first, then layers; each once). */
export function sceneAssetIds(scene: PrototypeScene): string[] {
  const ids = new Set<string>();
  if (scene.background) ids.add(scene.background.asset);
  for (const layer of scene.layers) {
    if (layer.image) ids.add(layer.image.asset);
  }
  return [...ids];
}

/* ------------------------------ blocks and PNGs ------------------------------ */

/** The page a palette block is rendered in: the e-Cidade window background, Arial 11px. */
export const blockDocument = (html: string, css: string): string =>
  renderDocument(
    `<div data-tf-block style="display:inline-block;padding:2px">${html}</div>`,
    `body{margin:0;background:#e0e0e0;font:11px Arial,Helvetica,sans-serif}${css}`,
  );

/** Width/height from the IHDR chunk of a PNG; null when it is not one. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 24 || !magic.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
