/*
 * A captured screen carries a big stylesheet (hundreds of KB). Parsing it into the GrapesJS
 * CssComposer creates thousands of <style> tags and makes the editor crawl, so the captured CSS is
 * kept apart as a read-only BASE stylesheet (one <style data-tf-base> in the canvas) and only the
 * rules created in the editor live in the composer. Both are stored in the single `css` string:
 *
 *   <base css> \n/* tf-edits *\/\n <rules made in the editor>
 *
 * A prototype without the marker (legacy, or css rewritten by someone else) is all base.
 */

export const TF_EDITS_MARKER = '/* tf-edits */';

const MARKER_RE = /\/\*\s*tf-edits\s*\*\//;

export interface StoredCss {
  base: string;
  edits: string;
}

export function splitStoredCss(css: string): StoredCss {
  const match = MARKER_RE.exec(css);
  if (!match) return { base: css, edits: '' };
  return {
    base: css.slice(0, match.index).trim(),
    edits: css.slice(match.index + match[0].length).trim(),
  };
}

export function joinStoredCss(base: string, edits: string): string {
  const b = base.trim();
  const e = edits.trim();
  if (!e) return b;
  return `${b}\n${TF_EDITS_MARKER}\n${e}`;
}

/**
 * Canvas-only css that pins the page to the prototype size. The canvas iframe has a FIXED size
 * (width x height); the page inside never decides it. Percent / `vh` heights of the captured css
 * resolve against that fixed viewport, and content taller than the page scrolls inside the frame.
 */
export function frameCanvasCss(height: number): string {
  const h = Math.max(1, Math.round(height));
  return `html{height:${h}px !important;max-height:${h}px !important}[data-gjs-type="wrapper"]{min-height:${h}px !important}`;
}
