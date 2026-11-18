import {
  EC_KIND_ATTR,
  EC_PART_ATTR,
  type EcidadeComponentKind,
  type EcidadeComponentPart,
} from '@thinkflow/shared';
import {
  decodeEntities,
  eachElement,
  getAttr,
  hasAttr,
  setAttr,
  type HtmlElement,
  type HtmlNode,
  type HtmlText,
} from './html-tree';
import { cellsOf, isHeaderRow, rowsOf } from './scrub';

/*
 * Recognition of e-Cidade components in a captured screen. It only ANNOTATES: `data-ec="<kind>"`
 * on the smallest element that holds a whole component and `data-ec-part="<part>"` on its pieces
 * (the contract is in `@thinkflow/shared`). Nothing is moved, wrapped (but for one bare `span`
 * around a loose text that must carry a part) or restyled, so the captured CSS keeps applying.
 * The visual editor turns every `data-ec` element into an editable component.
 *
 * The heuristics are generic (labels, controls and their order, not the routine) and conservative:
 * a pattern that is not clear is left alone.
 */

export type ComponentCounts = Partial<Record<EcidadeComponentKind, number>>;

/** Frames inlined by the capture (`div[data-tf-frame]`) and empty boxes that stand for frames. */
const FRAME_MARKS = ['data-tf-frame', 'data-tf-blank'];

const plain = (text: string): string =>
  decodeEntities(text)
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
const lowerAttr = (el: HtmlElement, name: string): string =>
  (getAttr(el, name) ?? '').toLowerCase();

/** Never a component root: they hold the whole screen or its structure. */
const STRUCTURAL = new Set([
  'html',
  'body',
  '#root',
  'form',
  'fieldset',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'select',
  'option',
  'head',
]);

const SKIPPED = new Set([
  'script',
  'style',
  'head',
  'title',
  'option',
  'optgroup',
  'template',
  'noscript',
  'svg',
  'map',
  'datalist',
]);

/** A break in the flow of labels and controls: a label never reaches across it. */
const BREAKERS = new Set([
  'table',
  'tr',
  'fieldset',
  'ul',
  'ol',
  'li',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'pre',
  'hr',
  'br',
]);

const isHidden = (el: HtmlElement): boolean =>
  hasAttr(el, 'hidden') ||
  /display\s*:\s*none/i.test(getAttr(el, 'style') ?? '') ||
  lowerAttr(el, 'type') === 'hidden';

// ---------------------------------------------------------------------------------------------
// tree helpers

class Tree {
  readonly parents = new Map<HtmlNode, HtmlElement>();
  readonly root: HtmlElement;
  /** Elements inside each element (itself not counted). */
  private readonly sizes = new Map<HtmlElement, number>();

  constructor(nodes: HtmlNode[]) {
    this.root = { type: 'element', tag: '#root', attrs: [], children: nodes };
    const index = (el: HtmlElement): number => {
      let size = 0;
      for (const child of el.children) {
        this.parents.set(child, el);
        if (child.type === 'element') size += 1 + index(child);
      }
      this.sizes.set(el, size);
      return size;
    };
    index(this.root);
  }

  parentOf(node: HtmlNode): HtmlElement | null {
    return this.parents.get(node) ?? null;
  }

  /** `node` is `ancestor` or inside it. */
  isInside(node: HtmlNode, ancestor: HtmlElement): boolean {
    for (let n: HtmlNode | null = node; n; n = this.parentOf(n)) if (n === ancestor) return true;
    return false;
  }

  /** From `node` (when an element) up to the root. */
  chain(node: HtmlNode): HtmlElement[] {
    const out: HtmlElement[] = [];
    for (let n: HtmlNode | null = node; n; n = this.parentOf(n)) {
      if (n.type === 'element') out.push(n);
    }
    return out;
  }

  /** The text of `el`, or null when it is longer than `limit` characters. */
  text(el: HtmlElement, limit: number): string | null {
    const parts: string[] = [];
    let size = 0;
    let visits = 0;
    const walk = (nodes: readonly HtmlNode[]): boolean => {
      for (const node of nodes) {
        if (++visits > 2000) return false;
        if (node.type === 'text') {
          parts.push(node.text);
          size += node.text.length;
          if (size > limit * 4) return false;
        } else if (node.type === 'element' && !SKIPPED.has(node.tag) && !isHidden(node)) {
          if (!walk(node.children)) return false;
        }
      }
      return true;
    };
    if (!walk(el.children)) return null;
    const text = plain(parts.join(' '));
    return text.length > limit ? null : text;
  }

  descendants(el: HtmlElement): number {
    return this.sizes.get(el) ?? 0;
  }
}

const hasControls = (el: HtmlElement): boolean => {
  let found = false;
  eachElement([el], (e) => {
    if (e.tag === 'select' || e.tag === 'textarea' || e.tag === 'button') found = true;
    else if (e.tag === 'input' && lowerAttr(e, 'type') !== 'hidden') found = true;
  });
  return found;
};

const hasFrameMark = (el: HtmlElement): boolean => {
  let found = false;
  eachElement([el], (e) => {
    if (FRAME_MARKS.some((m) => hasAttr(e, m))) found = true;
  });
  return found;
};

// ---------------------------------------------------------------------------------------------
// the annotator

const DATE_SEPARATOR = /^(a|à|até|ate|-|–)$/i;
const BREADCRUMB = /^[^<>]{1,80}?(?:\s+>\s+[^<>]{1,80}?)+$/;
const TITLE_CLASS =
  /(window|janela|win|frame)[-_]?(title|titulo|caption|header|bar)|(title|titulo)[-_]?bar|barra[-_]?(de[-_]?)?titulo/i;
const STATUS_LABEL = /Institui[cç][aã]o\s*:/i;
const OTHER_LABEL = /\p{L}[\p{L} .]{1,30}\s*:/u;
const TAB_CLASS = /(^|[\s_-])(tab|tabs|aba|abas)(\d*)($|[\s_-])/i;
const PANEL_CLASS = /(^|[\s_-])(panel|painel|conteudo|content|tabpanel)(\d*)($|[\s_-])/i;
const MESSAGE_CLASS =
  /(^|[\s_-])(alert|alerta|message|mensagem|msg|aviso|erro|error|warning|warn|info|sucesso|success|notice|notificacao)(\d*)($|[\s_-])/i;
const BLOCK_TAGS = new Set([
  'div',
  'p',
  'table',
  'ul',
  'ol',
  'dl',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'blockquote',
  'fieldset',
  'form',
]);
const MESSAGE_TAGS = new Set(['div', 'p', 'span', 'td', 'table', 'center', 'section']);

type TokKind =
  | 'text'
  | 'anchor'
  | 'input'
  | 'check'
  | 'radio'
  | 'select'
  | 'textarea'
  | 'button'
  | 'break'
  | 'opaque';

interface Tok {
  kind: TokKind;
  /** The element, or the text node of a `text` token. */
  node: HtmlNode;
  text: string;
  readonly: boolean;
  /** Radio group name / button caption / native date input. */
  name: string;
  native: boolean;
  style: string;
}

const isControl = (t: Tok): boolean =>
  t.kind === 'input' ||
  t.kind === 'check' ||
  t.kind === 'radio' ||
  t.kind === 'select' ||
  t.kind === 'textarea' ||
  t.kind === 'button';

interface Comp {
  kind: EcidadeComponentKind;
  tokens: Tok[];
  parts: { tok: Tok; part: EcidadeComponentPart }[];
}

const NATIVE_DATE_TYPES = new Set(['date', 'datetime-local', 'month', 'week']);
const BUTTON_TYPES = new Set(['button', 'submit', 'reset']);

/** Annotates `root` in place; returns how many components of each kind were recognized. */
export function annotateComponents(root: HtmlNode[]): ComponentCounts {
  return new Annotator(root).run();
}

/** Components counted in a stored HTML (`data-ec="<kind>"`). */
export function countComponents(html: string): ComponentCounts {
  const counts: Record<string, number> = {};
  for (const m of html.matchAll(new RegExp(`\\s${EC_KIND_ATTR}="([a-z-]+)"`, 'g'))) {
    counts[m[1]!] = (counts[m[1]!] ?? 0) + 1;
  }
  return counts;
}

class Annotator {
  private readonly tree: Tree;
  private readonly counts: ComponentCounts = {};
  /** Elements whose content is a component of its own: never read as labels and fields. */
  private readonly opaque = new Set<HtmlElement>();
  /** Roots of label+control components (they never nest). */
  private readonly claimed = new Set<HtmlElement>();
  private toks: Tok[] = [];
  private readonly ranges = new Map<HtmlElement, [number, number]>();

  constructor(nodes: HtmlNode[]) {
    this.tree = new Tree(nodes);
  }

  run(): ComponentCounts {
    this.windowTitle();
    this.statusBar();
    this.grids();
    this.tabs();
    this.messages();
    this.fieldsets();
    this.flatten(this.tree.root);
    for (const comp of this.classify()) this.place(comp);
    return this.counts;
  }

  private mark(el: HtmlElement, kind: EcidadeComponentKind): boolean {
    if (hasAttr(el, EC_KIND_ATTR)) return false;
    setAttr(el, EC_KIND_ATTR, kind);
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    return true;
  }

  private part(el: HtmlElement, part: EcidadeComponentPart): void {
    if (!hasAttr(el, EC_PART_ATTR)) setAttr(el, EC_PART_ATTR, part);
  }

  // ---- window title and status bar ----

  private windowTitle(): void {
    let found: HtmlElement | null = null;
    const visit = (el: HtmlElement) => {
      if (found || isHidden(el) || SKIPPED.has(el.tag)) return;
      if (!STRUCTURAL.has(el.tag) && el.tag !== 'a' && this.tree.descendants(el) <= 15) {
        const text = this.tree.text(el, 160);
        const byText = text !== null && BREADCRUMB.test(text);
        const byClass = TITLE_CLASS.test(
          `${getAttr(el, 'class') ?? ''} ${getAttr(el, 'id') ?? ''}`,
        );
        if ((byText || (byClass && text)) && !hasControls(el) && !hasFrameMark(el)) {
          found = el;
          return;
        }
      }
      for (const child of el.children) if (child.type === 'element') visit(child);
    };
    visit(this.tree.root);
    const title = found as HtmlElement | null;
    if (!title) return;
    this.mark(title, 'window-title');
    this.part(this.textHolder(title), 'title');
    this.opaque.add(title);
  }

  private statusBar(): void {
    let start: HtmlElement | null = null;
    const visit = (el: HtmlElement) => {
      if (start || isHidden(el) || SKIPPED.has(el.tag)) return;
      for (const child of el.children) {
        if (child.type === 'text' && STATUS_LABEL.test(plain(child.text))) {
          start = el;
          return;
        }
      }
      for (const child of el.children) if (child.type === 'element') visit(child);
    };
    visit(this.tree.root);
    let cur = start as HtmlElement | null;
    if (!cur) return;
    // up to the line that holds it: no fields, no frames, a few words
    for (let p = this.tree.parentOf(cur); p; p = this.tree.parentOf(cur)) {
      if (STRUCTURAL.has(p.tag) && p.tag !== 'table') break;
      if (p.tag === '#root' || hasControls(p) || hasFrameMark(p)) break;
      if (this.tree.text(p, 400) === null || this.tree.descendants(p) > 40) break;
      cur = p;
    }
    const text = this.tree.text(cur, 400) ?? '';
    // "Instituição: … Departamento: …": a field label "Instituição:" alone is not the status bar
    const after = text.slice(text.search(STATUS_LABEL)).replace(STATUS_LABEL, '');
    if (!OTHER_LABEL.test(after)) return;
    this.mark(cur, 'status-bar');
    this.part(start && start !== cur && this.tree.isInside(start, cur) ? start : cur, 'text');
    this.opaque.add(cur);
  }

  // ---- structure: grids, tabs, messages, fieldsets ----

  private grids(): void {
    const tables: HtmlElement[] = [];
    eachElement(this.tree.root.children, (el) => {
      if (el.tag === 'table' && !isHidden(el)) tables.push(el);
    });
    for (const table of tables) {
      if (this.opaque.has(table) || [...this.opaque].some((o) => this.tree.isInside(table, o)))
        continue;
      const grid = this.gridOf(table);
      if (!grid) continue;
      this.mark(table, 'grid');
      this.opaque.add(table);
      let cells = 0;
      for (const row of grid.header) this.part(row, 'header');
      grid.rows.slice(0, 100).forEach((row) => {
        this.part(row, 'row');
        for (const cell of cellsOf(row)) {
          if (cells++ < 800) this.part(cell, 'cell');
        }
      });
    }
  }

  /** A table with a header row and data rows (not a layout table of labels and fields). */
  private gridOf(table: HtmlElement): { header: HtmlElement[]; rows: HtmlElement[] } | null {
    const all = rowsOf(table);
    if (all.length < 2) return null;
    const header = all.filter((r) => r.section === 'thead').map((r) => r.row);
    const firstBody = all.find((r) => r.section !== 'thead');
    if (header.length === 0 && firstBody && isHeaderRow(firstBody.row)) header.push(firstBody.row);
    if (header.length === 0) return null;
    const headCells = cellsOf(header[0]!);
    // a header of `th` cells may be a single column; one made of bold cells needs a second one
    if (headCells.length < (headCells.every((c) => c.tag === 'th') ? 1 : 2)) return null;
    const headTexts = headCells.map((c) => plain(c.children.map(rawText).join('')));
    if (headTexts.every((t) => t === '' || t.endsWith(':'))) return null; // captions of a form
    const rows = all.map((r) => r.row).filter((r) => !header.includes(r));
    if (rows.length === 0) return null;
    // a layout table nests other tables / fieldsets in its cells
    let nested = false;
    for (const row of all)
      for (const cell of cellsOf(row.row))
        eachElement(cell.children, (e) => {
          if (e.tag === 'table' || e.tag === 'fieldset') nested = true;
        });
    if (nested) return null;
    // mostly fields: a form laid out in a table, not a list
    let withControls = 0;
    let filled = 0;
    for (const row of rows)
      for (const cell of cellsOf(row)) {
        const hasText = plain(cell.children.map(rawText).join('')) !== '';
        const hasField = hasControls(cell);
        if (hasText || hasField) filled++;
        if (hasField && !hasText) withControls++;
      }
    return filled > 0 && withControls / filled > 0.5 ? null : { header, rows };
  }

  private tabs(): void {
    const isTab = (el: HtmlElement): boolean =>
      lowerAttr(el, 'role') === 'tab' ||
      TAB_CLASS.test(`${getAttr(el, 'class') ?? ''} ${getAttr(el, 'id') ?? ''}`);
    const isPanel = (el: HtmlElement): boolean =>
      lowerAttr(el, 'role') === 'tabpanel' ||
      PANEL_CLASS.test(`${getAttr(el, 'class') ?? ''} ${getAttr(el, 'id') ?? ''}`);
    const visit = (el: HtmlElement) => {
      if (isHidden(el) || SKIPPED.has(el.tag) || this.opaque.has(el)) return;
      const kids = el.children.filter((c): c is HtmlElement => c.type === 'element');
      const tabs = kids.filter((k) => isTab(k) && (this.tree.text(k, 80) ?? '') !== '');
      if (tabs.length >= 2 && tabs.length >= kids.length - 1 && !hasAttr(el, EC_KIND_ATTR)) {
        // tab bar + its panels under one parent: the parent is the component
        const parent = this.tree.parentOf(el);
        const siblings = parent
          ? parent.children.filter((c): c is HtmlElement => c.type === 'element')
          : [];
        const panels = siblings.filter((s) => s !== el && isPanel(s));
        const holder =
          parent &&
          !STRUCTURAL.has(parent.tag) &&
          panels.length > 0 &&
          siblings.length === panels.length + 1
            ? parent
            : el;
        if (this.mark(holder, 'tabs')) {
          for (const tab of tabs) this.part(tab, 'tab');
          if (holder !== el) for (const panel of panels) this.part(panel, 'panel');
          this.opaque.add(el); // the bar; the panels still hold fields
        }
        return;
      }
      for (const child of kids) visit(child);
    };
    visit(this.tree.root);
  }

  private messages(): void {
    const visit = (el: HtmlElement) => {
      if (isHidden(el) || SKIPPED.has(el.tag) || this.opaque.has(el)) return;
      const role = lowerAttr(el, 'role');
      const byClass = MESSAGE_CLASS.test(
        `${getAttr(el, 'class') ?? ''} ${getAttr(el, 'id') ?? ''}`,
      );
      if (
        MESSAGE_TAGS.has(el.tag) &&
        (byClass || role === 'alert' || role === 'status') &&
        !hasControls(el) &&
        !hasFrameMark(el) &&
        !hasAttr(el, EC_KIND_ATTR)
      ) {
        const text = this.tree.text(el, 500);
        if (text) {
          this.mark(el, 'message');
          const lead = el.children.find((c) => c.type === 'element') as HtmlElement | undefined;
          const hasTitle =
            !!lead &&
            /^(b|strong|h[1-6])$/.test(lead.tag) &&
            (this.tree.text(lead, 120) ?? '') !== '';
          if (hasTitle) this.part(lead, 'title');
          this.messageText(el, hasTitle ? lead : null);
          this.opaque.add(el);
          return;
        }
      }
      for (const child of el.children) if (child.type === 'element') visit(child);
    };
    visit(this.tree.root);
  }

  /** The element whose text is all the text of `root`: the deepest one with the same text. */
  private textHolder(root: HtmlElement): HtmlElement {
    const text = this.tree.text(root, 400);
    let holder = root;
    for (;;) {
      const kids = holder.children.filter((c): c is HtmlElement => c.type === 'element');
      const next = kids.find((k) => this.tree.text(k, 400) === text);
      if (!next || holder.children.some((c) => c.type === 'text' && plain(c.text) !== '')) break;
      holder = next;
    }
    return holder;
  }

  /** `part="text"` for a message: its text element, or a bare span around the loose content. */
  private messageText(el: HtmlElement, lead: HtmlElement | null): void {
    const rest = el.children.filter((c) => c !== lead);
    const elements = rest.filter((c): c is HtmlElement => c.type === 'element');
    const loose = rest.some((c) => c.type === 'text' && plain(c.text) !== '');
    if (!loose && elements.length === 1) {
      this.part(this.textHolder(elements[0]!), 'text');
      return;
    }
    if (elements.some((e) => BLOCK_TAGS.has(e.tag))) {
      this.part(el, 'text');
      return;
    }
    const span: HtmlElement = {
      type: 'element',
      tag: 'span',
      attrs: [{ name: EC_PART_ATTR, value: 'text' }],
      children: rest,
    };
    el.children = lead ? [lead, span] : [span];
    for (const c of rest) this.tree.parents.set(c, span);
    this.tree.parents.set(span, el);
  }

  private fieldsets(): void {
    eachElement(this.tree.root.children, (el) => {
      if (el.tag !== 'fieldset' || isHidden(el)) return;
      this.mark(el, 'fieldset');
      const legend = el.children.find(
        (c): c is HtmlElement => c.type === 'element' && c.tag === 'legend',
      );
      if (legend) this.part(legend, 'legend');
    });
  }

  // ---- labels and controls ----

  private push(kind: TokKind, node: HtmlNode, extra: Partial<Tok> = {}): void {
    this.toks.push({
      kind,
      node,
      text: '',
      readonly: false,
      name: '',
      native: false,
      style: '',
      ...extra,
    });
  }

  /** Reads the tree into a flat sequence of labels, controls and breaks, with each element's span. */
  private flatten(el: HtmlElement): void {
    for (const node of el.children) {
      if (node.type === 'text') {
        const text = plain(node.text);
        if (text !== '') this.push('text', node, { text });
        continue;
      }
      if (node.type !== 'element') continue;
      this.element(node);
    }
  }

  private element(el: HtmlElement): void {
    const tag = el.tag;
    if (SKIPPED.has(tag) || isHidden(el)) return;
    const lo = this.toks.length;
    const done = () => this.ranges.set(el, [lo, this.toks.length]);
    if (this.opaque.has(el)) {
      this.push('break', el);
      this.push('opaque', el);
      this.push('break', el);
      return;
    }
    if (tag === 'legend') {
      this.push('break', el);
      return;
    }
    if (tag === 'input') {
      const type = lowerAttr(el, 'type') || 'text';
      const common = {
        readonly: hasAttr(el, 'readonly') || hasAttr(el, 'disabled'),
        style: lowerAttr(el, 'style'),
        name: getAttr(el, 'name') ?? '',
      };
      if (type === 'hidden' || type === 'image') return;
      if (BUTTON_TYPES.has(type)) {
        this.push('button', el, { ...common, text: plain(getAttr(el, 'value') ?? '') });
      } else if (type === 'checkbox') this.push('check', el, common);
      else if (type === 'radio') this.push('radio', el, common);
      else this.push('input', el, { ...common, native: NATIVE_DATE_TYPES.has(type) });
      done();
      return;
    }
    if (tag === 'select' || tag === 'textarea') {
      this.push(tag, el, { readonly: hasAttr(el, 'disabled') });
      done();
      return;
    }
    if (tag === 'button') {
      this.push('button', el, {
        text: plain(this.tree.text(el, 120) ?? getAttr(el, 'title') ?? ''),
      });
      done();
      return;
    }
    if (tag === 'a') {
      const text = this.tree.text(el, 120);
      if (text && !hasControls(el)) {
        this.push('anchor', el, { text });
        done();
        return;
      }
    }
    const breaker = BREAKERS.has(tag);
    if (breaker) this.push('break', el);
    const inner = this.toks.length;
    this.flatten(el);
    this.ranges.set(el, [inner, this.toks.length]);
    if (breaker) this.push('break', el);
  }

  private dateUnit(from: number): { inputs: Tok[]; button: Tok; all: Tok[]; next: number } | null {
    const inputs: Tok[] = [];
    const all: Tok[] = [];
    let k = from;
    for (; k < this.toks.length; k++) {
      const u = this.toks[k]!;
      if (u.kind === 'input' && !u.native) {
        inputs.push(u);
        all.push(u);
      } else if (
        u.kind === 'text' &&
        /^[/.-]$/.test(u.text) &&
        inputs.length > 0 &&
        this.toks[k + 1]?.kind === 'input'
      ) {
        all.push(u);
      } else break;
    }
    const button = this.toks[k];
    if (
      inputs.length === 0 ||
      inputs.length > 3 ||
      button?.kind !== 'button' ||
      button.text !== 'D'
    )
      return null;
    return { inputs, button, all: [...all, button], next: k + 1 };
  }

  /** Label and control tokens → components, in reading order. */
  private classify(): Comp[] {
    const toks = this.toks;
    const comps: Comp[] = [];
    let pending: Tok[] = [];
    const labelsOf = (label: Tok[]) => label.map((tok) => ({ tok, part: 'label' as const }));
    let i = 0;
    while (i < toks.length) {
      const t = toks[i]!;
      if (t.kind === 'text' || t.kind === 'anchor') {
        if (t.text.length > 90) pending = [];
        else {
          pending.push(t);
          if (pending.length > 3) pending.shift();
        }
        i++;
        continue;
      }
      if (t.kind === 'break' || t.kind === 'opaque') {
        pending = [];
        i++;
        continue;
      }
      const label = pending;
      pending = [];
      switch (t.kind) {
        case 'input': {
          const unit = this.dateUnit(i);
          if (unit) {
            let end = unit.next;
            const tokens = [...label, ...unit.all];
            const parts: Comp['parts'] = [
              ...labelsOf(label),
              ...unit.inputs.map((tok) => ({ tok, part: 'input' as const })),
              { tok: unit.button, part: 'button' as const },
            ];
            let kind: EcidadeComponentKind = 'date';
            const sep = toks[end];
            if (sep?.kind === 'text' && DATE_SEPARATOR.test(sep.text)) {
              const second = this.dateUnit(end + 1);
              if (second) {
                kind = 'date-range';
                tokens.push(sep, ...second.all);
                parts.push(
                  { tok: sep, part: 'separator' },
                  ...second.inputs.map((tok) => ({ tok, part: 'input' as const })),
                  { tok: second.button, part: 'button' as const },
                );
                end = second.next;
              }
            }
            comps.push({ kind, tokens, parts });
            i = end;
            break;
          }
          if (t.native) {
            comps.push({
              kind: 'date',
              tokens: [...label, t],
              parts: [...labelsOf(label), { tok: t, part: 'input' }],
            });
            i++;
            break;
          }
          const next = toks[i + 1];
          const desc =
            next?.kind === 'input' &&
            !next.native &&
            (next.readonly || /background/.test(next.style))
              ? next
              : null;
          const editable = !t.readonly;
          const anchor = label.some((l) => l.kind === 'anchor');
          if (editable && (anchor || (desc && next!.readonly))) {
            const tokens = [...label, t, ...(desc ? [desc] : [])];
            comps.push({
              kind: 'lookup',
              tokens,
              parts: [
                ...labelsOf(label),
                { tok: t, part: 'input' },
                ...(desc ? [{ tok: desc, part: 'desc' as const }] : []),
              ],
            });
            i += desc ? 2 : 1;
            break;
          }
          comps.push({
            kind: 'field',
            tokens: [...label, t],
            parts: [...labelsOf(label), { tok: t, part: 'input' }],
          });
          i++;
          break;
        }
        case 'select':
        case 'textarea':
          comps.push({
            kind: t.kind,
            tokens: [...label, t],
            parts: [...labelsOf(label), { tok: t, part: 'input' }],
          });
          i++;
          break;
        case 'check': {
          const after = toks[i + 1];
          const trailing = label.length === 0 && after?.kind === 'text' && after.text.length <= 80;
          const lab = trailing ? [after] : label;
          comps.push({
            kind: 'checkbox',
            tokens: [...lab, t],
            parts: [...labelsOf(lab), { tok: t, part: 'input' }],
          });
          i += trailing ? 2 : 1;
          break;
        }
        case 'radio': {
          const group = [t];
          const between: Tok[] = [];
          let last = i;
          for (let j = i + 1; j < toks.length; j++) {
            const u = toks[j]!;
            if (u.kind === 'radio' && u.name === t.name) {
              group.push(u);
              last = j;
            } else if (
              u.kind === 'text' ||
              (u.kind === 'break' && (u.node as HtmlElement).tag === 'br')
            ) {
              continue;
            } else break;
          }
          for (let j = i + 1; j < last; j++) between.push(toks[j]!);
          comps.push({
            kind: 'radio-group',
            tokens: [...label, t, ...between, ...group.slice(1)],
            parts: [...labelsOf(label), ...group.map((tok) => ({ tok, part: 'input' as const }))],
          });
          i = last + 1;
          break;
        }
        default: {
          // buttons: a run of them is a bar
          const run = [t];
          while (toks[i + run.length]?.kind === 'button') run.push(toks[i + run.length]!);
          comps.push({
            kind: run.length > 1 ? 'button-bar' : 'button',
            tokens: run,
            parts: run.length > 1 ? run.map((tok) => ({ tok, part: 'button' as const })) : [],
          });
          i += run.length;
        }
      }
    }
    return comps;
  }

  /** The smallest element holding every token of the component, when it holds nothing else. */
  private rootOf(comp: Comp): HtmlElement | null {
    const own = new Set(comp.tokens);
    const chains = comp.tokens.map((t) => this.tree.chain(t.node));
    if (chains.length === 0) return null;
    const rest = chains.slice(1).map((c) => new Set(c));
    const common = chains[0]!.find((el) => rest.every((set) => set.has(el)));
    if (!common || STRUCTURAL.has(common.tag) || FRAME_MARKS.some((m) => hasAttr(common, m)))
      return null;
    const range = this.ranges.get(common);
    if (!range) return null;
    for (let k = range[0]; k < range[1]; k++) {
      const tok = this.toks[k]!;
      if (own.has(tok) || tok.kind === 'text' || tok.kind === 'anchor') continue;
      return null; // another field, a break or a grid in the same element
    }
    return common;
  }

  private free(el: HtmlElement): boolean {
    if (hasAttr(el, EC_KIND_ATTR)) return false;
    for (const c of this.claimed) {
      if (this.tree.isInside(c, el) || this.tree.isInside(el, c)) return false;
    }
    return true;
  }

  private place(comp: Comp): void {
    let root = this.rootOf(comp);
    if (root && !this.free(root)) return; // already a component (or inside one): leave it
    if (!root) {
      // the label and the control do not share an element of their own: the control alone
      const control = comp.tokens.find(isControl);
      const el = control?.node as HtmlElement | undefined;
      if (!el || !this.free(el)) return;
      root = el;
    }
    if (!this.mark(root, comp.kind)) return;
    this.claimed.add(root);
    for (const { tok, part } of comp.parts) this.markPart(tok, part, root);
  }

  private markPart(tok: Tok, part: EcidadeComponentPart, root: HtmlElement): void {
    if (tok.node.type === 'element') {
      if (tok.node !== root && this.tree.isInside(tok.node, root)) this.part(tok.node, part);
      return;
    }
    // a loose text: the element that holds only it, or a bare span around it
    const text = tok.node as HtmlText;
    const parent = this.tree.parentOf(text);
    if (!parent || !this.tree.isInside(parent, root)) return;
    let target: HtmlElement | null = null;
    if (parent !== root && this.onlyLabel(parent)) {
      target = parent;
      for (
        let up = this.tree.parentOf(target);
        up &&
        up !== root &&
        this.tree.isInside(up, root) &&
        this.onlyChild(up, target) &&
        this.onlyLabel(up);
        up = this.tree.parentOf(target)
      ) {
        target = up;
      }
    }
    if (target) {
      this.part(target, part);
      return;
    }
    const span: HtmlElement = {
      type: 'element',
      tag: 'span',
      attrs: [{ name: EC_PART_ATTR, value: part }],
      children: [text],
    };
    parent.children[parent.children.indexOf(text)] = span;
    this.tree.parents.set(text, span);
    this.tree.parents.set(span, parent);
  }

  /** `el` holds text and no field, grid or frame. */
  private onlyLabel(el: HtmlElement): boolean {
    return !hasControls(el) && !hasFrameMark(el) && !hasAttr(el, EC_PART_ATTR);
  }

  private onlyChild(parent: HtmlElement, child: HtmlElement): boolean {
    return parent.children.every((c) => c === child || (c.type === 'text' && plain(c.text) === ''));
  }
}

const rawText = (node: HtmlNode): string =>
  node.type === 'text'
    ? node.text
    : node.type === 'element'
      ? node.children.map(rawText).join('')
      : '';
