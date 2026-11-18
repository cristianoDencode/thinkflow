/**
 * Mermaid normalizer: pure TypeScript, no dependencies, idempotent.
 *
 * Turns whatever a model (or NotebookLM) produced into Markdown where every Mermaid diagram is a
 * ```mermaid fence with repaired source. It never touches ASCII art or real code blocks.
 *
 * Pipeline (see `normalizeDiagrams`):
 *   1. fence parser   - fenced blocks are labeled/relabeled as mermaid when they look like Mermaid;
 *   2. unfenced scan  - strict Mermaid header + diagram-like body outside any fence is fenced;
 *   3. source repairs - `repairMermaidSource` fixes the usual LLM syntax mistakes.
 */

/* ------------------------------------------------------------------ */
/* Public types and constants                                          */
/* ------------------------------------------------------------------ */

export const MERMAID_KEYWORDS: readonly string[] = [
  'flowchart',
  'graph',
  'sequenceDiagram',
  'erDiagram',
  'classDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'gantt',
  'journey',
  'pie',
  'mindmap',
  'timeline',
  'gitGraph',
  'quadrantChart',
  'xychart-beta',
  'sankey-beta',
  'block-beta',
  'requirementDiagram',
  // Recognised inside ```mermaid fences only (never auto-detected when unfenced).
  'architecture-beta',
  'packet-beta',
  'kanban',
  'C4Context',
];

export interface DiagramBlock {
  /** Position of the diagram in the document (0-based). */
  index: number;
  /** Repaired Mermaid source, without fences. LF line endings. */
  code: string;
  /** The block exactly as found in the input (fence lines included when it was fenced). */
  original: string;
  /** Canonical diagram type: flowchart, sequenceDiagram, erDiagram, ... or "unknown". */
  kind: string;
  /** Codes of every fix applied (fence-level and source-level). */
  fixes: string[];
  /** Whether the diagram was already inside a code fence. */
  fenced: boolean;
}

export interface NormalizeResult {
  text: string;
  diagrams: DiagramBlock[];
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const KEYWORDS_BY_LENGTH = [...MERMAID_KEYWORDS].sort((a, b) => b.length - a.length);

function group(m: RegExpExecArray | RegExpMatchArray | null, i: number): string {
  return m?.[i] ?? '';
}

function leadingWs(line: string): number {
  return group(/^[ \t]*/.exec(line), 0).length;
}

function removeIndent(line: string, n: number): string {
  let k = 0;
  while (k < n && (line[k] === ' ' || line[k] === '\t')) k++;
  return line.slice(k);
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* Header detection                                                    */
/* ------------------------------------------------------------------ */

/**
 * Strict Mermaid header detection for one line (used to start unfenced blocks and to accept
 * unlabeled fences). Returns the diagram kind or null.
 */
export function detectMermaidHeader(line: string): string | null {
  const t = line.trim();
  if (/^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\s*;?$/i.test(t)) return 'flowchart';
  if (/^flowchart\s*;?$/.test(t)) return 'flowchart';
  const m =
    /^(sequenceDiagram|erDiagram|classDiagram|stateDiagram(?:-v2)?|gantt|journey|mindmap|timeline|gitGraph|quadrantChart|xychart-beta|sankey-beta|block-beta|requirementDiagram)\s*;?$/.exec(
      t,
    );
  if (m) return group(m, 1);
  if (/^pie(?:\s+showData)?(?:\s+title\s+.+)?$/.test(t)) return 'pie';
  return null;
}

function headerRestOk(kw: string, rest: string): boolean {
  const r = rest.replace(/;\s*$/, '').trim();
  if (kw === 'flowchart' || kw === 'graph') return r === '' || /^(?:TB|TD|BT|RL|LR)$/i.test(r);
  if (kw === 'pie') return r === '' || /^(?:showData)?\s*(?:title\s+.+)?$/.test(r);
  return r === '';
}

/** Lenient header match (case-insensitive keyword) used inside blocks already believed to be Mermaid. */
function matchKeyword(line: string): { kw: string; rest: string } | null {
  const t = line.trim();
  for (const kw of KEYWORDS_BY_LENGTH) {
    if (t.slice(0, kw.length).toLowerCase() !== kw.toLowerCase()) continue;
    const rest = t.slice(kw.length);
    if (rest !== '' && /^[\w-]/.test(rest)) continue;
    if (!headerRestOk(kw, rest)) continue;
    return { kw, rest };
  }
  return null;
}

function kindOfKeyword(kw: string): string {
  return kw === 'graph' ? 'flowchart' : kw;
}

/** Index of the first meaningful line: skips blanks, `%%` directives/comments and YAML frontmatter. */
function findHeaderIndex(lines: string[]): number {
  let i = 0;
  let frontmatterDone = false;
  while (i < lines.length) {
    const t = (lines[i] ?? '').trim();
    if (t === '' || t.startsWith('%%')) {
      i++;
      continue;
    }
    if (t === '---' && !frontmatterDone) {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? '').trim() !== '---') j++;
      if (j >= lines.length) return -1;
      frontmatterDone = true;
      i = j + 1;
      continue;
    }
    return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* ASCII art                                                           */
/* ------------------------------------------------------------------ */

/** Box-drawing characters, `+---+` borders, `| text |` boxes or `|` / `v` connector columns. */
export function looksLikeAsciiArt(code: string): boolean {
  const lines = code.split(/\r?\n/);
  const box = /[┌┐└┘│─├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▲▼◄►]/u;
  if (lines.filter((l) => box.test(l)).length >= 2) return true;
  if (lines.filter((l) => /\+[-=]{3,}\+/.test(l)).length >= 1) return true;
  if (lines.filter((l) => /^\s*[|vV^]\s*$/.test(l)).length >= 2) return true;
  const piped = lines.filter(
    (l) => /^\s*\|.*\|\s*$/.test(l) && !/-->|---|==>|\|\|--|--o|o--|\.\./.test(l),
  );
  return piped.length >= 3;
}

/* ------------------------------------------------------------------ */
/* Character-level clean-up                                            */
/* ------------------------------------------------------------------ */

const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-f]+)|(gt|lt|amp|quot|apos|nbsp));/gi;

function decodeEntity(match: string, dec?: string, hex?: string, name?: string): string {
  if (name) {
    switch (name.toLowerCase()) {
      case 'gt':
        return '>';
      case 'lt':
        return '<';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return ' ';
    }
  }
  const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex ?? '', 16);
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
  if (code === 0xa0) return ' ';
  return String.fromCodePoint(code);
}

function cleanChars(code: string, fixes: Set<string>): string {
  let s = code;
  if (s.includes('\r')) {
    s = s.replace(/\r\n?/g, '\n');
    fixes.add('crlf');
  }
  if (s.includes('\t')) {
    s = s.replace(/\t/g, '    ');
    fixes.add('tabs');
  }
  if (/[\u200B-\u200D\u2060\uFEFF]/.test(s)) {
    s = s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
    fixes.add('zero-width');
  }
  if (/[\u00A0\u202F\u2007]/.test(s)) {
    s = s.replace(/[\u00A0\u202F\u2007]/g, ' ');
    fixes.add('nbsp');
  }
  if (/[“”„‟‘’‚‛]/.test(s)) {
    s = s.replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'");
    fixes.add('smart-quotes');
  }
  if (ENTITY_RE.test(s)) {
    ENTITY_RE.lastIndex = 0;
    s = s.replace(ENTITY_RE, decodeEntity);
    fixes.add('html-entities');
  }
  ENTITY_RE.lastIndex = 0;
  return s;
}

/* ------------------------------------------------------------------ */
/* Line-level clean-up                                                 */
/* ------------------------------------------------------------------ */

const CITATION_RE = /([ \t]*)\[(\d+(?:[ \t]*[-,–][ \t]*\d+)*)\]/g;

/** NotebookLM citation markers like `[1]`, `[2, 3]`, `[4-6]` (never `A[1]` node labels). */
function stripCitations(line: string): string {
  return line.replace(CITATION_RE, (match: string, ws: string, _n: string, offset: number) => {
    const prev = offset > 0 ? line.charAt(offset - 1) : '';
    if (ws === '' && (prev === '' || /[\p{L}\p{N}_[({]/u.test(prev))) return match;
    return '';
  });
}

const LIST_MARKER_RE = /^(\s*)(?:[-*•]|\d+[.)])[ \t]+/;

function isComment(line: string): boolean {
  return line.trim().startsWith('%%');
}

function stripTrailingSemicolons(line: string): string {
  let t = line.replace(/[ \t]+$/, '');
  while (t.endsWith(';') && !/#[A-Za-z0-9]+;$/.test(t) && count(t, '"') % 2 === 0) {
    t = t.slice(0, -1).replace(/[ \t]+$/, '');
  }
  return t;
}

/* ------------------------------------------------------------------ */
/* Flowchart repairs                                                   */
/* ------------------------------------------------------------------ */

const NEEDS_QUOTE_RE = /[()[\]{}<>:;|/#&%"\\]|\P{ASCII}/u;
const SKIP_FLOW_RE = /^(?:classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b|^%%/;
const IDENT_RE = /[\p{L}\p{N}\p{M}_]+/uy;

const VALID_ARROWS: RegExp[] = [
  /<?-{2,}>/y,
  /<?={2,}>/y,
  /<?-\.+->/y,
  /-\.+-/y,
  /-{3,}/y,
  /={3,}/y,
  /<?(?:--|==)[ox](?=[ \t|]|$)/y,
  /~{3,}/y,
];

const BROKEN_ARROWS: Array<[RegExp, string]> = [
  [/-+[ \t]+-+>/y, '-->'],
  [/-{2,}[ \t]+>/y, '-->'],
  [/[–—―‒]{1,2}>/y, '-->'],
  [/[→⟶➔➜⇒⟹⟼]/y, '-->'],
  [/=[ \t]+=+>/y, '==>'],
  [/={2,}[ \t]+>/y, '==>'],
  [/<->/y, '<-->'],
  [/=>/y, '==>'],
  [/->(?!>)/y, '-->'],
];

const TEXT_ARROW_RE =
  /(--|==|-\.)[ \t]+(.+?)[ \t]+(-->|---|--[ox]|==>|===|==[ox]|\.->|\.-)(?=[ \t]|$|[|"&\p{L}\p{N}_])/uy;

const PIPE_ARROW: Record<string, string> = {
  '-->': '-->',
  '---': '---',
  '--x': '--x',
  '--o': '--o',
  '==>': '==>',
  '===': '===',
  '==x': '==x',
  '==o': '==o',
  '.->': '-.->',
  '.-': '-.-',
};

const SHAPES: Array<[string, string[]]> = [
  ['(((', [')))']],
  ['((', ['))']],
  ['([', ['])']],
  ['(', [')']],
  ['[[', [']]']],
  ['[(', [')]']],
  ['[/', ['/]', '\\]']],
  ['[\\', ['\\]', '/]']],
  ['[', [']']],
  ['{{', ['}}']],
  ['{', ['}']],
  ['>', [']']],
];

interface Shape {
  start: number;
  open: string;
  close: string;
  content: string;
  end: number;
}

/** Index of the bracket that balances the opener at `p`, or -1. */
function findShapeEnd(s: string, p: number, open: string, quoteAware: boolean, family: boolean) {
  const fam = open === '>' ? '[' : open.charAt(0);
  const openers = family ? fam : '([{';
  const closers = family ? (fam === '(' ? ')' : fam === '[' ? ']' : '}') : ')]}';
  let depth = open === '>' ? 1 : 0;
  let inQuote = false;
  for (let k = open === '>' ? p + 1 : p; k < s.length; k++) {
    const c = s.charAt(k);
    if (c === '"' && quoteAware) {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (openers.includes(c)) depth++;
    else if (closers.includes(c)) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

function parseShape(s: string, from: number, allowSpace: boolean): Shape | null {
  let p = from;
  if (allowSpace) while (s.charAt(p) === ' ') p++;
  for (const [open, closers] of SHAPES) {
    if (!s.startsWith(open, p)) continue;
    for (const [quoteAware, family] of [
      [true, false],
      [false, false],
      [false, true],
    ] as const) {
      const end = findShapeEnd(s, p, open, quoteAware, family);
      if (end < 0) continue;
      for (const close of closers) {
        const closeStart = end - close.length + 1;
        if (closeStart >= p + open.length && s.slice(closeStart, end + 1) === close) {
          return {
            start: p,
            open,
            close,
            content: s.slice(p + open.length, closeStart),
            end: end + 1,
          };
        }
      }
    }
  }
  return null;
}

function isQuoted(t: string): boolean {
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') && !t.slice(1, -1).includes('"');
}

/** Wrap a label in quotes when it holds characters Mermaid's lexer chokes on. */
function fixLabel(content: string, fixes: Set<string>, fixCode: string): string {
  const t = content.trim();
  if (t === '' || isQuoted(t)) return content;
  const quote = (inner: string) => `"${inner.replace(/"/g, '#quot;')}"`;
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    fixes.add(fixCode);
    return quote(t.slice(1, -1));
  }
  if (NEEDS_QUOTE_RE.test(t) || t === 'end') {
    fixes.add(fixCode);
    return quote(t);
  }
  return content;
}

function endOfQuote(s: string, i: number): number {
  const j = s.indexOf('"', i + 1);
  return j < 0 ? s.length : j + 1;
}

function asciiId(id: string): string {
  const cleaned = id
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned === '' ? 'n' : cleaned;
}

function needsRename(id: string): boolean {
  return id === 'end' || /\P{ASCII}/u.test(id);
}

interface FlowCtx {
  emit: boolean;
  fixes: Set<string>;
  seen: Map<string, { shape: boolean }>;
  map: Map<string, string>;
  labelled: Set<string>;
}

function finalizeIds(ctx: FlowCtx): void {
  const used = new Set<string>();
  for (const id of ctx.seen.keys()) if (!needsRename(id)) used.add(id);
  for (const id of ctx.seen.keys()) {
    if (!needsRename(id)) continue;
    const base = id === 'end' ? 'endNode' : asciiId(id);
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}_${n}`;
    used.add(candidate);
    ctx.map.set(id, candidate);
  }
}

function tokenizeFlowLine(line: string, ctx: FlowCtx): string {
  const indent = group(/^[ \t]*/.exec(line), 0);
  let s = line.slice(indent.length);
  const t = s.trim();
  if (t === '' || t === 'end' || SKIP_FLOW_RE.test(t)) return line;

  let prefix = '';
  let allowSpace = false;
  const sg = /^subgraph\s+/.exec(s);
  if (sg) {
    const rest = s.slice(sg[0].length);
    if (!/^[\p{L}\p{N}_-]+[ \t]*[[({]/u.test(rest)) return line;
    prefix = sg[0];
    s = rest;
    allowSpace = true;
  }

  const n = s.length;
  let i = 0;
  let out = '';
  let afterArrow = false;
  while (i < n) {
    const ch = s.charAt(i);
    if (ch === ' ' || ch === '\t') {
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      const e = endOfQuote(s, i);
      out += s.slice(i, e);
      i = e;
      afterArrow = false;
      continue;
    }
    if (ch === '%' && s.charAt(i + 1) === '%') {
      out += s.slice(i);
      break;
    }
    if (ch === '|' && afterArrow) {
      let j = -1;
      const next = s.slice(i + 1).trimStart();
      if (next.startsWith('"')) {
        const qStart = s.indexOf('"', i + 1);
        const qEnd = s.indexOf('"', qStart + 1);
        if (qEnd >= 0) j = s.indexOf('|', qEnd + 1);
      }
      if (j < 0) j = s.indexOf('|', i + 1);
      if (j > 0) {
        out += `|${fixLabel(s.slice(i + 1, j), ctx.fixes, 'quote-edge-label')}|`;
        i = j + 1;
        afterArrow = false;
        continue;
      }
    }
    if ('-=<~–—―‒→⟶➔➜⇒⟹⟼'.includes(ch)) {
      const arrow = matchArrow(s, i, ctx);
      if (arrow) {
        out += arrow.text;
        i += arrow.length;
        afterArrow = true;
        continue;
      }
    }
    if (ch === ':' && s.startsWith(':::', i)) {
      IDENT_RE.lastIndex = i + 3;
      const cls = IDENT_RE.exec(s);
      const len = cls ? cls[0].length : 0;
      out += s.slice(i, i + 3 + len);
      i += 3 + len;
      afterArrow = false;
      continue;
    }
    if (ch === '@' && s.charAt(i + 1) === '{') {
      const e = s.indexOf('}', i);
      const end = e < 0 ? n : e + 1;
      out += s.slice(i, end);
      i = end;
      afterArrow = false;
      continue;
    }
    IDENT_RE.lastIndex = i;
    const run = IDENT_RE.exec(s);
    if (run && run.index === i) {
      const id = run[0];
      const j = i + id.length;
      const shape = parseShape(s, j, allowSpace);
      if (!ctx.emit) {
        const prev = ctx.seen.get(id);
        ctx.seen.set(id, { shape: (prev?.shape ?? false) || shape !== null });
      }
      const mapped = ctx.map.get(id) ?? id;
      if (mapped !== id && ctx.emit) ctx.fixes.add(id === 'end' ? 'end-id' : 'ascii-id');
      if (shape) {
        out +=
          mapped +
          s.slice(j, shape.start) +
          shape.open +
          fixLabel(shape.content, ctx.fixes, 'quote-label') +
          shape.close;
        i = shape.end;
      } else {
        out += mapped;
        if (mapped !== id && ctx.emit && !ctx.seen.get(id)?.shape && !ctx.labelled.has(id)) {
          ctx.labelled.add(id);
          out += `["${id}"]`;
        }
        i = j;
      }
      afterArrow = false;
      allowSpace = false;
      continue;
    }
    out += ch;
    afterArrow = false;
    i++;
  }
  return indent + prefix + out;
}

function matchArrow(s: string, i: number, ctx: FlowCtx): { text: string; length: number } | null {
  for (const re of VALID_ARROWS) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m) return { text: m[0], length: m[0].length };
  }
  TEXT_ARROW_RE.lastIndex = i;
  const ta = TEXT_ARROW_RE.exec(s);
  if (ta) {
    const text = group(ta, 2);
    const arrow = PIPE_ARROW[group(ta, 3)];
    const trimmed = text.trim();
    if (arrow && !isQuoted(trimmed) && NEEDS_QUOTE_RE.test(trimmed.replace(/\P{ASCII}/gu, ''))) {
      ctx.fixes.add('quote-edge-label');
      return {
        text: `${arrow}|${fixLabel(text, ctx.fixes, 'quote-edge-label')}|`,
        length: ta[0].length,
      };
    }
    return { text: ta[0], length: ta[0].length };
  }
  for (const [re, replacement] of BROKEN_ARROWS) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m) {
      ctx.fixes.add('arrows');
      return { text: replacement, length: m[0].length };
    }
  }
  return null;
}

function repairFlowchart(lines: string[], header: number, fixes: Set<string>): string[] {
  const ctx: FlowCtx = { emit: false, fixes, seen: new Map(), map: new Map(), labelled: new Set() };
  const body = lines.slice(header + 1);
  for (const l of body) tokenizeFlowLine(l, ctx);
  finalizeIds(ctx);
  ctx.emit = true;
  return [...lines.slice(0, header + 1), ...body.map((l) => tokenizeFlowLine(l, ctx))];
}

/* ------------------------------------------------------------------ */
/* sequenceDiagram / erDiagram repairs                                 */
/* ------------------------------------------------------------------ */

function repairSequence(lines: string[], header: number, fixes: Set<string>): string[] {
  return lines.map((line, idx) => {
    if (idx <= header || line.trim().startsWith('%%')) return line;
    const colon = line.indexOf(':');
    if (colon < 0) return line;
    const tail = line.slice(colon + 1);
    const fixed = tail.replace(/(?<!#[A-Za-z0-9]{1,8});/g, '#59;');
    if (fixed === tail) return line;
    fixes.add('sequence-semicolon');
    return line.slice(0, colon + 1) + fixed;
  });
}

const ER_ATTR_RE =
  /\s*([A-Za-z][\w()*[\]]*)\s+([\w.-]+)((?:\s+(?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?)(?:\s+("[^"]*"))?/y;

function parseErAttributes(content: string): string[] | null {
  const text = content.trim();
  if (text === '') return null;
  const attrs: string[] = [];
  ER_ATTR_RE.lastIndex = 0;
  let pos = 0;
  while (pos < text.length) {
    ER_ATTR_RE.lastIndex = pos;
    const m = ER_ATTR_RE.exec(text);
    if (!m || m[0].length === 0) return null;
    const keys = group(m, 3).trim().replace(/\s+/g, ' ');
    attrs.push([group(m, 1), group(m, 2), keys, group(m, 4)].filter((x) => x !== '').join(' '));
    pos += m[0].length;
  }
  return attrs;
}

const ER_CARD = '(?:\\|\\||\\|o|o\\||\\}\\||\\|\\{|\\}o|o\\{)';
const ER_REL_RE = new RegExp(
  `^(\\s*)(\\S+)(\\s+)(${ER_CARD}(?:--|\\.\\.)${ER_CARD})(\\s+)(\\S+)\\s*:\\s*(.+)$`,
);

function repairEr(lines: string[], header: number, fixes: Set<string>): string[] {
  const out: string[] = [];
  lines.forEach((line, idx) => {
    if (idx <= header) {
      out.push(line);
      return;
    }
    const block = /^(\s*)([A-Za-z_][\w-]*)\s*\{\s*(.+?)\s*\}\s*$/.exec(line);
    if (block) {
      const attrs = parseErAttributes(group(block, 3));
      if (attrs) {
        const ind = group(block, 1);
        out.push(`${ind}${group(block, 2)} {`, ...attrs.map((a) => `${ind}    ${a}`), `${ind}}`);
        fixes.add('er-inline-attributes');
        return;
      }
    }
    const rel = ER_REL_RE.exec(line);
    if (rel) {
      const label = group(rel, 7).trim();
      if (!isQuoted(label) && !/^[A-Za-z_][\w-]*$/.test(label)) {
        const inner = label.startsWith('"') && label.endsWith('"') ? label.slice(1, -1) : label;
        fixes.add('er-relationship-label');
        out.push(
          `${group(rel, 1)}${group(rel, 2)}${group(rel, 3)}${group(rel, 4)}${group(rel, 5)}${group(rel, 6)} : "${inner.replace(/"/g, '#quot;')}"`,
        );
        return;
      }
    }
    out.push(line);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* repairMermaidSource                                                 */
/* ------------------------------------------------------------------ */

/**
 * Source-level fixes for one diagram body (no fences). `defaultHeader` is added when the body has
 * no header at all (e.g. the model labeled the fence `flowchart` and omitted the first line).
 */
export function repairMermaidSource(
  code: string,
  defaultHeader?: string,
): { code: string; kind: string | null; fixes: string[] } {
  const fixes = new Set<string>();
  const cleaned = cleanChars(code, fixes);
  let lines = cleaned.split('\n');
  const h = findHeaderIndex(lines);
  if (h < 0) return { code: cleaned, kind: null, fixes: [...fixes] };

  let km = matchKeyword(lines[h] ?? '');
  if (!km && defaultHeader) {
    lines.splice(h, 0, defaultHeader);
    fixes.add('add-header');
    km = matchKeyword(defaultHeader);
  }
  if (!km) return { code: cleaned, kind: null, fixes: [...fixes] };

  const kind = kindOfKeyword(km.kw);
  let header: string;
  if (km.kw === 'flowchart' || km.kw === 'graph') {
    const dir = km.rest.replace(/;\s*$/, '').trim().toUpperCase() || 'TD';
    header = `${km.kw} ${dir}`;
  } else {
    header = km.kw + km.rest.replace(/;\s*$/, '');
  }
  if ((lines[h] ?? '').trim() !== header) {
    if (!fixes.has('add-header')) fixes.add('header');
    lines[h] = header;
  }

  // Citations, list markers, trailing semicolons (body only; header already canonical).
  let body = lines.slice(h + 1);
  const stripped = body.map((l) => (isComment(l) ? l : stripCitations(l)));
  if (stripped.some((l, i) => l !== body[i])) fixes.add('citations');
  body = stripped;

  const nonBlank = body.filter((l) => l.trim() !== '');
  if (nonBlank.length > 0 && nonBlank.every((l) => LIST_MARKER_RE.test(l))) {
    body = body.map((l) => l.replace(LIST_MARKER_RE, '$1'));
    fixes.add('list-markers');
  }

  const noSemi = body.map((l) => (isComment(l) ? l : stripTrailingSemicolons(l)));
  if (noSemi.some((l, i) => l !== body[i])) fixes.add('trailing-semicolon');
  body = noSemi;

  lines = [...lines.slice(0, h + 1), ...body];
  if (kind === 'flowchart') lines = repairFlowchart(lines, h, fixes);
  else if (kind === 'sequenceDiagram') lines = repairSequence(lines, h, fixes);
  else if (kind === 'erDiagram') lines = repairEr(lines, h, fixes);

  return { code: lines.join('\n'), kind, fixes: [...fixes] };
}

/* ------------------------------------------------------------------ */
/* Fence handling                                                      */
/* ------------------------------------------------------------------ */

interface FenceOpen {
  indent: string;
  marker: string;
  ch: string;
  len: number;
  info: string;
}

function parseFenceOpen(line: string): FenceOpen | null {
  const m = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const marker = group(m, 2);
  const info = group(m, 3);
  if (marker.startsWith('`') && info.includes('`')) return null;
  return {
    indent: group(m, 1),
    marker,
    ch: marker.charAt(0),
    len: marker.length,
    info: info.trim(),
  };
}

function isFenceClose(line: string, open: FenceOpen): boolean {
  const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
  const marker = group(m, 1);
  return marker !== '' && marker.charAt(0) === open.ch && marker.length >= open.len;
}

function labelOf(info: string): string {
  return group(/^[{.\s]*([A-Za-z][\w+-]*)/.exec(info), 1).toLowerCase();
}

const MERMAID_LABELS = new Set(['mermaid', 'mmd', 'mermaidjs', 'mermaid-js']);
const PLAIN_LABELS = new Set([
  '',
  'text',
  'plaintext',
  'txt',
  'plain',
  'diagram',
  'diagrama',
  'fluxo',
  'fluxograma',
]);
const DEFAULT_HEADERS: Record<string, string> = {
  flowchart: 'flowchart TD',
  graph: 'flowchart TD',
  sequence: 'sequenceDiagram',
  sequencediagram: 'sequenceDiagram',
  er: 'erDiagram',
  erdiagram: 'erDiagram',
  class: 'classDiagram',
  classdiagram: 'classDiagram',
  state: 'stateDiagram-v2',
  statediagram: 'stateDiagram-v2',
  gantt: 'gantt',
  journey: 'journey',
  pie: 'pie',
  mindmap: 'mindmap',
  timeline: 'timeline',
  gitgraph: 'gitGraph',
};

const FLOW_HINT_RE = /-->|---|==>|-\.->|--[ox]\b|[\p{L}\p{N}_]\s*(?:\[|\(|\{)/u;

/** Is the headerless body plausible for the labeled diagram type? Guards against real code. */
function plausibleBody(label: string, code: string): boolean {
  if (code.trim() === '') return false;
  switch (DEFAULT_HEADERS[label]) {
    case 'flowchart TD':
      return FLOW_HINT_RE.test(code);
    case 'sequenceDiagram':
      return /->>|-->>|->|-\)/.test(code);
    case 'erDiagram':
      return /\|\||\}o|o\{|\|o|o\|/.test(code);
    case 'classDiagram':
      return /<\|--|--\|>|\*--|--\*|-->|\.\.>|\.\.\|>/.test(code);
    case 'stateDiagram-v2':
      return /-->/.test(code);
    default:
      return true;
  }
}

/** Header for a labeled fence: honours `graph LR` style info strings. */
function headerFromInfo(info: string, label: string): string | undefined {
  const fallback = DEFAULT_HEADERS[label];
  if (!fallback) return undefined;
  const dir = /^[{.\s]*(?:flowchart|graph)\s+(TB|TD|BT|RL|LR)\b/i.exec(info);
  if (dir && fallback === 'flowchart TD')
    return `${label === 'graph' ? 'graph' : 'flowchart'} ${group(dir, 1).toUpperCase()}`;
  return fallback;
}

function inferHeader(code: string): string | undefined {
  if (/->>|-->>/.test(code)) return 'sequenceDiagram';
  if (/-->|---|==>|-\.->/.test(code)) return 'flowchart TD';
  return undefined;
}

interface Rewrite {
  lines: string[];
  block: DiagramBlock | null;
  changed: boolean;
}

function handleFence(raw: string[], open: FenceOpen, index: number, eolCrlf: boolean): Rewrite {
  const label = labelOf(open.info);
  const bodyRaw = raw.slice(1, -1);
  const dedented = bodyRaw.map((l) => removeIndent(l, open.indent.length));
  const code = dedented.join('\n');
  const keep: Rewrite = { lines: raw, block: null, changed: false };

  let defaultHeader: string | undefined;
  const isMermaidLabel = MERMAID_LABELS.has(label);
  const canonical = /^mermaid(?:\s|$)/.test(open.info);
  if (isMermaidLabel) {
    if (
      findHeaderIndex(dedented) >= 0 &&
      !matchKeyword(dedented[findHeaderIndex(dedented)] ?? '')
    ) {
      defaultHeader = inferHeader(code);
    }
  } else if (label in DEFAULT_HEADERS) {
    if (looksLikeAsciiArt(code)) return keep;
    const hi = findHeaderIndex(dedented);
    if (hi < 0) return keep;
    if (!matchKeyword(dedented[hi] ?? '')) {
      if (!plausibleBody(label, code)) return keep;
      defaultHeader = headerFromInfo(open.info, label);
    }
  } else if (PLAIN_LABELS.has(label)) {
    const hi = findHeaderIndex(dedented);
    if (hi < 0 || !detectMermaidHeader(dedented[hi] ?? '') || looksLikeAsciiArt(code)) return keep;
  } else {
    return keep;
  }

  const repaired = repairMermaidSource(code, defaultHeader);
  const fixes = [...repaired.fixes];
  if (!canonical) fixes.unshift('relabel-fence');
  if (eolCrlf && !fixes.includes('crlf')) fixes.push('crlf');
  const block: DiagramBlock = {
    index,
    code: repaired.code,
    original: raw.join('\n'),
    kind: repaired.kind ?? 'unknown',
    fixes,
    fenced: true,
  };
  const unchanged = canonical && repaired.code === code;
  if (unchanged) return { lines: raw, block, changed: false };

  const openLine = canonical ? (raw[0] ?? '') : `${open.indent}${open.marker}mermaid`;
  const body = repaired.code.split('\n').map((l) => (l === '' ? l : open.indent + l));
  return { lines: [openLine, ...body, raw[raw.length - 1] ?? open.marker], block, changed: true };
}

/* ------------------------------------------------------------------ */
/* Unfenced blocks                                                     */
/* ------------------------------------------------------------------ */

interface HeaderLine {
  indent: number;
  quoteDepth: number;
  text: string;
  kind: string;
}

function parseHeaderLine(line: string): HeaderLine | null {
  const indent = leadingWs(line);
  let rest = line.slice(indent);
  let quoteDepth = 0;
  while (rest.startsWith('>')) {
    quoteDepth++;
    rest = rest.slice(1).replace(/^[ \t]+/, '');
  }
  rest = rest.replace(/^(?:[-*+•]|\d+[.)])[ \t]+/, '');
  const text = rest.trim();
  const kind = detectMermaidHeader(text);
  return kind ? { indent, quoteDepth, text, kind } : null;
}

function stripQuote(line: string, depth: number): string | null {
  let l = line;
  for (let d = 0; d < depth; d++) {
    const m = /^[ \t]*>[ \t]?/.exec(l);
    if (!m) return null;
    l = l.slice(m[0].length);
  }
  return l;
}

const ARROW_ANY =
  /-->|---|-\.+->|==>|->>|--[xo)]|-\)|<--|<\|--|--\|>|\.\.>|\.\.\|>|\*--|--\*|(?:--|\.\.)(?:\|\||o\||\|o|\|\{|o\{)|(?:\|\||\|o|o\||\}\||\}o)(?:--|\.\.)|->|→|=>|[–—]>/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,}|={3,})$/;
const NODE_ADJ_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*[[({>]/u;
const LOOSE_INDENT_KINDS = new Set([
  'mindmap',
  'timeline',
  'gantt',
  'journey',
  'pie',
  'quadrantChart',
  'xychart-beta',
  'sankey-beta',
  'block-beta',
  'requirementDiagram',
  'gitGraph',
  'stateDiagram',
  'stateDiagram-v2',
  'classDiagram',
  'erDiagram',
]);
const BRACE_KINDS = new Set([
  'erDiagram',
  'classDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'requirementDiagram',
]);

function kindSpecific(t: string, kind: string, indented: boolean): boolean {
  switch (kind) {
    case 'flowchart':
      return (
        /^(?:subgraph|end|classDef|class|style|linkStyle|click|direction)\b/.test(t) ||
        NODE_ADJ_RE.test(t) ||
        (indented && /^[\p{L}\p{N}_-]+$/u.test(t))
      );
    case 'sequenceDiagram':
      return /^(?:participant|actor|Note\s+(?:over|left of|right of)|note\s+(?:over|left of|right of)|loop|alt|else|opt|par|and|end|rect|critical|option|break|activate|deactivate|autonumber|box|title|create|destroy|links?)\b/.test(
        t,
      );
    case 'erDiagram':
      return /^[\w"-]+\s*\{/.test(t);
    case 'classDiagram':
      return (
        /^(?:class|namespace|note)\s+\S+/.test(t) ||
        /^[\w.<>~]+\s*:\s*[+\-#~]/.test(t) ||
        /^<<.*>>/.test(t) ||
        /^[\w.<>~]+\s*\{\s*$/.test(t)
      );
    case 'stateDiagram':
    case 'stateDiagram-v2':
      return /^(?:state|note|\[\*\]|--)/.test(t) || /^\w+ : \S/.test(t);
    case 'gantt':
      return (
        /^(?:title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|section|weekday|weekend|inclusiveEndDates|topAxis|accTitle|accDescr)\b/.test(
          t,
        ) || /:.*(?:\d{4}-\d{2}-\d{2}|\bafter\b|\b\d+[dwhms]\b)/.test(t)
      );
    case 'journey':
      return /^(?:title|section)\b/.test(t) || /^[^:]+:\s*[1-5]\s*(?::|$)/.test(t);
    case 'pie':
      return /^"[^"]*"\s*:\s*[\d.]+/.test(t) || /^(?:title|showData)\b/.test(t);
    case 'timeline':
      return /^(?:title|section)\b/.test(t) || /^\S.*\s:\s+\S/.test(t) || /^\d{3,4}\s*:/.test(t);
    case 'mindmap':
      return NODE_ADJ_RE.test(t);
    case 'gitGraph':
      return /^(?:commit|branch|checkout|merge|cherry-pick|tag)\b/.test(t);
    case 'quadrantChart':
      return /^(?:title|x-axis|y-axis|quadrant-\d)\b|^"?[^:]+"?\s*:\s*\[/.test(t);
    case 'xychart-beta':
      return /^(?:title|x-axis|y-axis|bar|line)\b/.test(t);
    case 'sankey-beta':
      return /^[^,]+,[^,]+,[\d.]+$/.test(t);
    case 'block-beta':
      return /^(?:columns|block|space|end)\b/.test(t) || NODE_ADJ_RE.test(t);
    case 'requirementDiagram':
      return /^(?:requirement|functionalRequirement|interfaceRequirement|performanceRequirement|physicalRequirement|designConstraint|element)\b/.test(
        t,
      );
    default:
      return false;
  }
}

function isDiagramLine(l: string, kind: string, base: number, state: { brace: number }): boolean {
  const t = l.trim();
  if (HR_RE.test(t)) return false;
  const indented = leadingWs(l) > base;
  const braced = BRACE_KINDS.has(kind);
  let ok: boolean;
  if (braced && state.brace > 0) ok = true;
  else if (t.startsWith('%%')) ok = true;
  else if (/^[{}]$/.test(t)) ok = true;
  else if (ARROW_ANY.test(t)) ok = true;
  else if (indented && LOOSE_INDENT_KINDS.has(kind)) ok = true;
  else ok = kindSpecific(t, kind, indented);
  if (ok && braced) state.brace = Math.max(0, state.brace + count(t, '{') - count(t, '}'));
  return ok;
}

function collectUnfenced(
  lines: string[],
  h: number,
  hp: HeaderLine,
): { end: number; body: string[] } | null {
  const body: string[] = [];
  const state = { brace: 0 };
  let k = h + 1;
  let blanks = 0;
  let last = h;
  while (k < lines.length) {
    let l = lines[k] ?? '';
    if (hp.quoteDepth > 0) {
      const q = stripQuote(l, hp.quoteDepth);
      if (q === null) break;
      l = q;
    }
    if (l.trim() === '') {
      blanks++;
      if (blanks > 1) break;
      k++;
      continue;
    }
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(l) || parseFenceOpen(l)) break;
    if (!isDiagramLine(l, hp.kind, hp.indent, state)) break;
    for (let b = 0; b < blanks; b++) body.push('');
    blanks = 0;
    body.push(l);
    last = k;
    k++;
  }
  if (body.length === 0) return null;
  return { end: last + 1, body };
}

/* ------------------------------------------------------------------ */
/* normalizeDiagrams                                                   */
/* ------------------------------------------------------------------ */

/**
 * Markdown in -> Markdown where every detected Mermaid diagram is a ```mermaid fence with repaired
 * source. Idempotent. Unclosed fences (streaming) and non-Mermaid fences are left untouched.
 */
export function normalizeDiagrams(markdown: string): NormalizeResult {
  const crlf = markdown.includes('\r\n');
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  const diagrams: DiagramBlock[] = [];
  let changed = false;
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i] ?? '';
    const open = parseFenceOpen(line);
    if (open) {
      let j = i + 1;
      while (j < n && !isFenceClose(lines[j] ?? '', open)) j++;
      if (j >= n) {
        out.push(...lines.slice(i));
        break;
      }
      const res = handleFence(lines.slice(i, j + 1), open, diagrams.length, crlf);
      out.push(...res.lines);
      if (res.block) diagrams.push(res.block);
      if (res.changed) changed = true;
      i = j + 1;
      continue;
    }

    // Optional stray "mermaid" label line right before an unfenced header.
    let start = i;
    let hLine = i;
    let stray = false;
    if (/^\s*mermaid\s*$/i.test(line) && i + 1 < n && parseHeaderLine(lines[i + 1] ?? '')) {
      hLine = i + 1;
      stray = true;
    }
    const hp = parseHeaderLine(lines[hLine] ?? '');
    if (hp) {
      const res = collectUnfenced(lines, hLine, hp);
      if (res) {
        if (stray) start = i;
        const original = lines.slice(start, res.end).join(crlf ? '\r\n' : '\n');
        const full = [hp.text, ...res.body.map((l) => removeIndent(l, hp.indent))].join('\n');
        const repaired = repairMermaidSource(full);
        const fixes: string[] = [
          hp.indent >= 4 && hp.quoteDepth === 0 ? 'indented-code' : 'unfenced',
        ];
        if (stray) fixes.push('stray-mermaid-label');
        if (hp.quoteDepth > 0) fixes.push('blockquote');
        for (const f of repaired.fixes) if (!fixes.includes(f)) fixes.push(f);
        if (crlf && !fixes.includes('crlf')) fixes.push('crlf');
        const fenceIndent = hp.indent < 4 ? ' '.repeat(hp.indent) : '';
        out.push(
          `${fenceIndent}\`\`\`mermaid`,
          ...repaired.code.split('\n').map((l) => (l === '' ? l : fenceIndent + l)),
          `${fenceIndent}\`\`\``,
        );
        diagrams.push({
          index: diagrams.length,
          code: repaired.code,
          original,
          kind: repaired.kind ?? hp.kind,
          fixes,
          fenced: false,
        });
        changed = true;
        i = res.end;
        continue;
      }
    }
    out.push(line);
    i++;
  }

  return { text: changed ? out.join(crlf ? '\r\n' : '\n') : markdown, diagrams };
}
