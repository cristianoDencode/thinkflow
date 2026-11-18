import type { Component } from 'grapesjs';
import { FREE_SOURCE_ATTR, type EcidadeComponentKind } from '@thinkflow/shared';
import type { BlockDef } from './ecidade-blocks';
import {
  captionOf,
  ecKindOf,
  gridColumns,
  itemText,
  itemsOf,
  partOf,
  partsOf,
  tagOf,
  textSegments,
  textOf,
  walk,
} from './ec-model';
import { wrapRowHtml, isRowTag } from './ec-insert';

/*
 * Names of recognized components (Layer manager) and the "Desta tela" palette: one block per
 * distinct kind + structure among the components of the loaded screen.
 */

export const SCREEN_CATEGORY = 'Desta tela';

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

const KIND_ICON: Record<EcidadeComponentKind, string> = {
  'window-title': '▬',
  'status-bar': '▁',
  fieldset: '▢',
  field: 'Ab|',
  lookup: '🔍',
  date: '📅',
  'date-range': '📅',
  select: '▾',
  textarea: '¶',
  checkbox: '☑',
  'radio-group': '◉',
  button: '▭',
  'button-bar': '▭▭',
  grid: '▦',
  tabs: '⊟',
  message: 'ⓘ',
};

const clip = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** "Número do Empenho:" -> "Número do Empenho". */
const clean = (text: string) => clip(text.replace(/[\s:]+$/, '').trim());

const joinList = (names: string[], max: number) =>
  `${names.slice(0, max).join(', ')}${names.length > max ? '…' : ''}`;

function buttonCaptions(root: Component): string[] {
  const buttons = partsOf(root, 'button');
  return itemsOf(root, buttons)
    .map(itemText)
    .filter((t) => t && t !== ' ');
}

/** The main text of a component: its label, caption, title, legend or first column names. */
function mainText(root: Component, kind: EcidadeComponentKind): string {
  switch (kind) {
    case 'window-title':
      return textOf(partOf(root, 'title') ?? root);
    case 'status-bar':
      return clip(textSegments(root)[0] ?? '');
    case 'fieldset':
      return textOf(partOf(root, 'legend'));
    case 'button':
      return captionOf(partOf(root, 'button') ?? root);
    case 'message':
      return textOf(partOf(root, 'text') ?? root);
    default:
      return textOf(partOf(root, 'label'));
  }
}

/** "Lookup: Número do Empenho", "Grade (5 colunas)": the Layer manager name. */
export function layerName(root: Component, kind: EcidadeComponentKind): string {
  switch (kind) {
    case 'grid': {
      const n = gridColumns(root).length;
      return `Grade (${n} ${n === 1 ? 'coluna' : 'colunas'})`;
    }
    case 'button-bar': {
      const n = buttonCaptions(root).length;
      return `Barra de botões (${n} ${n === 1 ? 'botão' : 'botões'})`;
    }
    case 'tabs': {
      const n = partsOf(root, 'tab').length;
      return `Abas (${n})`;
    }
    case 'status-bar':
      return KIND_NAME[kind];
    default: {
      const text = clean(mainText(root, kind));
      return text ? `${KIND_NAME[kind]}: ${text}` : KIND_NAME[kind];
    }
  }
}

/** "Lookup (Número do Empenho)", "Grade (Empenho, Credor, Valor)": the palette preview label. */
export function paletteLabel(root: Component, kind: EcidadeComponentKind): string {
  const name = KIND_NAME[kind];
  let detail = '';
  switch (kind) {
    case 'date-range':
      break;
    case 'grid':
      detail = joinList(gridColumns(root).map(clean), 3);
      break;
    case 'button-bar':
      detail = joinList(buttonCaptions(root).map(clean), 4);
      break;
    case 'tabs':
      detail = joinList(
        partsOf(root, 'tab').map((t) => clean(textOf(t))),
        4,
      );
      break;
    default:
      detail = clean(mainText(root, kind));
  }
  return detail ? `${name} (${detail})` : name;
}

/* ---- "Desta tela" -------------------------------------------------------------------------- */

export interface ScreenBlock extends BlockDef {
  kind: EcidadeComponentKind;
  signature: string;
  /** The first component of the screen with this structure (what "Favoritar" saves). */
  component: Component;
}

const STRIP_ATTRS = [
  'id',
  'value',
  'checked',
  'selected',
  'placeholder',
  'title',
  'name',
  'href',
  'data-ec-fav',
];

/** Structure of an element: tags, classes and attributes, with texts and values stripped. */
export function structureSignature(html: string, kind: EcidadeComponentKind): string {
  const rowTag = /^\s*<(tr|td|th)\b/i.exec(html)?.[1]?.toLowerCase();
  const doc = new DOMParser().parseFromString(
    rowTag ? `<table><tbody>${rowTag === 'tr' ? '' : '<tr>'}${html}</tbody></table>` : html,
    'text/html',
  );
  const root = rowTag ? doc.querySelector(rowTag) : doc.body.firstElementChild;
  if (!root) return kind;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ALL);
  const dead: Node[] = [];
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === 3) (n as Text).data = '';
    else if (n.nodeType === 8) dead.push(n);
    else if (n.nodeType === 1) STRIP_ATTRS.forEach((a) => (n as Element).removeAttribute(a));
  }
  dead.forEach((n) => n.parentNode?.removeChild(n));
  if (kind === 'grid') {
    // the number of data rows does not make another kind of grid: keep header + first data row
    Array.from(root.querySelectorAll('tbody > tr'))
      .slice(1)
      .forEach((r) => r.remove());
  }
  return `${kind}|${root.outerHTML.replace(/\s+/g, ' ')}`;
}

const MAX_SCREEN_BLOCKS = 60;

/** Closest `<table>` ancestor attributes of a row-like component (to wrap it when dropped). */
function tableAttrsOf(c: Component): Record<string, string> {
  for (let p = c.parent(); p; p = p.parent()) {
    if (tagOf(p) !== 'table') continue;
    const attrs = { ...p.getAttributes() } as Record<string, string>;
    delete attrs.id;
    Object.keys(attrs).forEach((k) => k.startsWith('data-ec') && delete attrs[k]);
    const classes = p.getClasses();
    if (classes.length) attrs.class = classes.join(' ');
    return attrs;
  }
  return {};
}

/** The exportable markup of a component; row-like roots come wrapped in a minimal table. */
export function componentMarkup(c: Component): string {
  const html = c.toHTML();
  return isRowTag(tagOf(c)) ? wrapRowHtml(html, tagOf(c), tableAttrsOf(c)) : html;
}

/** One palette block per distinct kind + structure of the recognized components of the screen. */
export function buildScreenBlocks(wrapper: Component): ScreenBlock[] {
  const seen = new Set<string>();
  const blocks: ScreenBlock[] = [];
  walk(wrapper, (c) => {
    if (blocks.length >= MAX_SCREEN_BLOCKS) return false;
    // a free layout keeps the originals hidden next to their copies: list each component once
    if (c.getAttributes()[FREE_SOURCE_ATTR] !== undefined) return false;
    const kind = ecKindOf(c);
    if (!kind) return true;
    const html = c.toHTML();
    const signature = structureSignature(html, kind);
    if (!seen.has(signature)) {
      seen.add(signature);
      blocks.push({
        id: `screen-${blocks.length + 1}`,
        label: paletteLabel(c, kind),
        category: SCREEN_CATEGORY,
        icon: KIND_ICON[kind],
        html: componentMarkup(c),
        css: '',
        kind,
        signature,
        component: c,
      });
    }
    return true; // nested components (fields inside a group) get their own block too
  });
  return blocks;
}
