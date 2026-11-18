/** Largest SVG accepted from the diagram renderer. */
export const SVG_MAX_CHARS = 2_000_000;

const TAG_RE = /<[^<>]*>/g;

/**
 * Accepts only a plain, inert `<svg>` produced by our Mermaid renderer: no scripts, no
 * foreignObject/iframe, no event handlers, no `javascript:`, and no reference to anything but
 * `#fragments` and `data:image/` URLs. Anything else is rejected and the diagram stays as code.
 */
export function isSafeSvg(svg: string): boolean {
  if (typeof svg !== 'string' || svg.length === 0 || svg.length > SVG_MAX_CHARS) return false;
  if (!/^\s*<svg[\s>]/i.test(svg)) return false;
  if (/<\s*(script|foreignObject|iframe|object|embed|link|meta|base)\b/i.test(svg)) return false;
  if (/javascript\s*:/i.test(svg)) return false;
  if (/<!ENTITY|<!DOCTYPE/i.test(svg)) return false;
  // CSS: no @import and no url() other than #fragments / data:image
  if (/@import/i.test(svg)) return false;
  for (const match of svg.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const target = match[2]!.trim();
    if (!target.startsWith('#') && !/^data:image\//i.test(target)) return false;
  }
  for (const tag of svg.match(TAG_RE) ?? []) {
    if (/[\s"'/]on[a-z]+\s*=/i.test(tag)) return false;
    for (const attr of tag.matchAll(
      /(?:^|[\s"'/])(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    )) {
      const value = (attr[1] ?? attr[2] ?? attr[3] ?? '').trim();
      if (!value.startsWith('#') && !/^data:image\//i.test(value)) return false;
    }
  }
  return true;
}
