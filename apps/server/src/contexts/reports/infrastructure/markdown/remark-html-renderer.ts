import { hashDiagram } from '@thinkflow/shared';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import type { MarkdownToHtml, RenderMarkdownOptions } from '../../domain/render-ports';
import { isSafeSvg } from '../../domain/svg-guard';
import { sanitizePrototypeHtml } from './prototype-sanitizer';

/** Minimal structural view of the hast nodes the finishing plugin touches. */
interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

type Schema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

/** Default GitHub-like schema; remote images are dropped and only data: sources survive. */
const SCHEMA: Schema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, src: ['data'] },
};

const SAFE_IMG = /^data:image\/(png|jpeg|gif|webp);base64,/i;

const textOf = (node: HNode): string =>
  node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join('');

const el = (tagName: string, properties: Record<string, unknown>, children: HNode[]): HNode => ({
  type: 'element',
  tagName,
  properties,
  children,
});
const text = (value: string): HNode => ({ type: 'text', value });

function diagramFigure(code: string, svgByHash: Record<string, string>): HNode {
  const hash = hashDiagram(code);
  const svg = svgByHash[hash];
  if (svg && isSafeSvg(svg))
    return el('figure', { className: ['diagram'], dataHash: hash }, [{ type: 'raw', value: svg }]);
  return el('figure', { className: ['diagram'], dataHash: hash }, [
    el('pre', { className: ['mermaid-fallback'] }, [el('code', {}, [text(code)])]),
    el('figcaption', {}, [text('Diagrama não validado (código Mermaid).')]),
  ]);
}

/**
 * Runs AFTER the sanitizer, so it may only add nodes it builds itself: mermaid blocks become a
 * figure (guarded SVG or escaped code), `h2` get the ids of the table of contents and images
 * without a data: source disappear.
 */
function finish(options: RenderMarkdownOptions) {
  const svgByHash = options.svgByHash ?? {};
  const ids = options.headingIds ?? {};
  const walk = (node: HNode): void => {
    const children = node.children;
    if (!children) return;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]!;
      if (child.type !== 'element') continue;
      if (child.tagName === 'pre') {
        const code = child.children?.find((c) => c.type === 'element' && c.tagName === 'code');
        const classes = code?.properties?.className;
        if (code && Array.isArray(classes) && classes.includes('language-mermaid')) {
          children[i] = diagramFigure(textOf(code).replace(/\n$/, ''), svgByHash);
          continue;
        }
      } else if (child.tagName === 'h2') {
        const id = ids[textOf(child).trim()];
        if (id) child.properties = { ...child.properties, id };
      } else if (child.tagName === 'img') {
        const src = child.properties?.src;
        if (typeof src !== 'string' || !SAFE_IMG.test(src)) {
          const alt = child.properties?.alt;
          children.splice(i, 1, ...(typeof alt === 'string' && alt ? [text(alt)] : []));
          continue;
        }
      }
      walk(child);
    }
  };
  return () => (tree: unknown) => walk(tree as HNode);
}

/**
 * Markdown -> sanitized HTML. Raw HTML in the Markdown is never honoured (remark-rehype without
 * `allowDangerousHtml`), the result goes through `rehype-sanitize`, and the only raw node in the
 * tree is a Mermaid SVG that passed `isSafeSvg`.
 */
export class RemarkHtmlRenderer implements MarkdownToHtml {
  render(markdown: string, options: RenderMarkdownOptions = {}): string {
    return String(
      unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkRehype)
        .use(rehypeSanitize, SCHEMA)
        .use(finish(options))
        .use(rehypeStringify, { allowDangerousHtml: true })
        .processSync(markdown),
    );
  }

  sanitizePrototype(html: string): string {
    return sanitizePrototypeHtml(html);
  }
}
