import rehypeParse from 'rehype-parse';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';

type Schema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

const TAGS = [
  'div',
  'section',
  'nav',
  'header',
  'footer',
  'main',
  'aside',
  'h1',
  'h2',
  'h3',
  'h4',
  'p',
  'span',
  'strong',
  'em',
  'ul',
  'ol',
  'li',
  'a',
  'button',
  'form',
  'label',
  'input',
  'select',
  'option',
  'textarea',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'img',
  'small',
  'hr',
];

const INPUT_TYPES = [
  'text',
  'email',
  'password',
  'number',
  'search',
  'tel',
  'date',
  'checkbox',
  'radio',
];

/**
 * Allowlist for the HTML a model writes for a prototype screen: layout and form tags with the
 * `tf-*` component classes only; no `style`, no `id`, no event handlers, no scripts, and links
 * only to other screens (`#tela-<slug>`).
 */
export const PROTOTYPE_SCHEMA: Schema = {
  ...defaultSchema,
  strip: ['script', 'style', 'noscript', 'template'],
  tagNames: TAGS,
  clobber: [],
  clobberPrefix: '',
  protocols: { href: [], src: ['data'] },
  attributes: {
    '*': [['className', /^tf-[a-z0-9-]+$/]],
    a: [['href', /^#tela-[a-z0-9-]+$/]],
    button: [['type', 'button', 'submit'], 'disabled'],
    input: [['type', ...INPUT_TYPES], 'placeholder', 'value', 'name', 'disabled', 'checked'],
    select: ['name', 'disabled'],
    option: ['value', 'selected', 'disabled'],
    textarea: ['placeholder', 'name', 'rows', 'disabled'],
    label: [],
    img: ['alt', ['src', /^data:image\/(png|jpeg|gif);/]],
    td: ['colSpan', 'rowSpan'],
    th: ['colSpan', 'rowSpan'],
  },
  required: {},
  ancestors: {},
};

export function sanitizePrototypeHtml(html: string): string {
  return String(
    unified()
      .use(rehypeParse, { fragment: true })
      .use(rehypeSanitize, PROTOTYPE_SCHEMA)
      .use(rehypeStringify)
      .processSync(html),
  ).trim();
}
