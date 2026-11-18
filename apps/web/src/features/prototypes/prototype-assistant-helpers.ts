/*
 * Helpers of the prototype assistant panel: the sandboxed preview document, a readable text form
 * of the markup/CSS for the diff, and a line diff.
 */

/** Whether a `<body>` holds nothing visible (no element besides <style>, no text). */
export function isBlankHtml(html: string): boolean {
  const withoutShell = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?(?:body|html|head)\b[^>]*>/gi, '');
  return withoutShell.replace(/\s+/g, '') === '';
}

/**
 * Document of a preview iframe. The iframe is sandboxed without `allow-scripts` and this document
 * also carries a CSP that allows nothing but inline styles and `data:` pictures/fonts.
 */
export function buildPreviewDoc(html: string, css: string): string {
  // a "<" inside the stylesheet could close the <style> element
  const safeCss = css.replace(/</g, '\\3c ');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; font-src data:; style-src \'unsafe-inline\'">' +
    `<style>html,body{margin:0}${safeCss}</style></head>${html}</html>`
  );
}

/** One tag / text / rule per line, indented by depth. */
export function htmlLines(html: string): string[] {
  const VOID = /^<(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\b/i;
  const lines: string[] = [];
  let depth = 0;
  for (const part of html.split(/(<[^>]+>)/)) {
    const piece = part.trim();
    if (!piece) continue;
    if (piece.startsWith('</')) depth = Math.max(0, depth - 1);
    lines.push(`${'  '.repeat(depth)}${piece}`);
    if (
      /^<[a-z]/i.test(piece) &&
      !VOID.test(piece) &&
      !piece.endsWith('/>') &&
      !/<\/[a-z]+>$/i.test(piece)
    )
      depth++;
  }
  return lines;
}

/** One declaration block per line (`.a{x:1}` → `.a {` … `}` kept compact). */
export function cssLines(css: string): string[] {
  return css
    .replace(/\s+/g, ' ')
    .split(/(?<=\})/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface LinePart {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** Above this many line pairs the LCS table is skipped (everything counts as changed). */
const MAX_CELLS = 4_000_000;

/** Line diff (longest common subsequence), one list with the three kinds in reading order. */
export function lineDiff(before: string[], after: string[]): LinePart[] {
  if (before.length * after.length > MAX_CELLS)
    return [
      ...before.map((text) => ({ kind: 'removed' as const, text })),
      ...after.map((text) => ({ kind: 'added' as const, text })),
    ];
  const width = after.length + 1;
  const lcs = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        before[i] === after[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  const out: LinePart[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      out.push({ kind: 'same', text: before[i]! });
      i++;
      j++;
    } else if (
      j < after.length &&
      (i === before.length || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)
    ) {
      out.push({ kind: 'added', text: after[j]! });
      j++;
    } else {
      out.push({ kind: 'removed', text: before[i]! });
      i++;
    }
  }
  return out;
}

/** Keeps the changed lines and `context` lines around them; gaps become one "…" line. */
export function collapseSame(parts: LinePart[], context = 2): LinePart[] {
  const keep = new Array<boolean>(parts.length).fill(false);
  parts.forEach((p, i) => {
    if (p.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(parts.length - 1, i + context); k++)
      keep[k] = true;
  });
  const out: LinePart[] = [];
  let skipped = false;
  parts.forEach((p, i) => {
    if (keep[i]) {
      out.push(p);
      skipped = false;
    } else if (!skipped) {
      out.push({ kind: 'same', text: '…' });
      skipped = true;
    }
  });
  return out;
}
