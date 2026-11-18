/**
 * Finds the ```mermaid fences of a Markdown document (indented ones inside list items included)
 * and lets the caller rewrite their source. Fences of other languages are skipped whole, so a
 * "```mermaid" quoted inside a Python block is never touched.
 */

const OPEN = /^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)[^\n]*$/;

const dedent = (line: string, width: number): string => {
  let i = 0;
  while (i < width && i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
};

export interface MermaidFence {
  /** Source, dedented, without the fence lines. */
  code: string;
}

/**
 * Calls `rewrite(code)` for every mermaid fence; a returned string replaces the source, `null`
 * keeps it. Returns the new Markdown and the codes seen in order.
 */
export function mapMermaidFences(
  markdown: string,
  rewrite: (code: string) => string | null,
): { markdown: string; codes: string[] } {
  const lines = markdown.split('\n');
  const out: string[] = [];
  const codes: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = OPEN.exec(line);
    if (!open) {
      out.push(line);
      i++;
      continue;
    }
    const [, indent = '', marker = '```', info = ''] = open;
    const closeRe = new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !closeRe.test(lines[end]!)) end++;
    const closed = end < lines.length;
    const body = lines.slice(i + 1, end);
    if (info.toLowerCase() === 'mermaid' && closed) {
      const code = body.map((l) => dedent(l, indent.length)).join('\n');
      codes.push(code);
      const replaced = rewrite(code);
      out.push(line);
      if (replaced === null) out.push(...body);
      else out.push(...replaced.split('\n').map((l) => (l === '' ? l : indent + l)));
      out.push(lines[end]!);
    } else {
      out.push(line, ...body);
      if (closed) out.push(lines[end]!);
    }
    i = closed ? end + 1 : end;
  }
  return { markdown: out.join('\n'), codes };
}

/** Sources of the mermaid fences, in order (duplicates kept). */
export function mermaidCodes(markdown: string): string[] {
  return mapMermaidFences(markdown, () => null).codes;
}
