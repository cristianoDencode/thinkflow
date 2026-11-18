import type { PiiKind } from '@thinkflow/shared';
import { detectAll } from '../../privacy/domain/detect';
import { decodeEntities, eachElement, type HtmlNode } from './html-tree';

/*
 * LGPD: personal data that is part of the screen itself (the CPF in the header bar, the name of
 * the logged user, a creditor in a message…) must not stay in a stored prototype either. The
 * privacy detectors of the AI firewall run over every text node and over the attributes that show
 * text; what they find is replaced by a fictitious value of the same kind and shape.
 */

const SKIP_PARENTS = new Set(['script', 'style']);
/** Attributes whose value is shown (or read) as text. */
const TEXT_ATTRS = [
  'title',
  'alt',
  'value',
  'placeholder',
  'aria-label',
  'aria-description',
  'label',
];
/** Shorter than this holds no CPF, no e-mail and no two-word name. */
const MIN_LENGTH = 5;
const MAX_ATTR_LENGTH = 2000;

const hasLowercase = (text: string): boolean => /\p{Ll}/u.test(text);

/** The fictitious stand-in of a detected value: same shape, nothing real. */
export function placeholderFor(kind: PiiKind, original: string): string {
  switch (kind) {
    case 'EMAIL':
      return 'usuario@exemplo.com';
    case 'NOME': {
      const name = 'Nome Exemplo';
      return hasLowercase(original) ? name : name.toUpperCase();
    }
    case 'ENDERECO':
      return 'Endereço Exemplo';
    case 'SEGREDO':
      return '••••••';
    case 'PLACA':
      return original.replace(/\p{L}/gu, 'A').replace(/\d/g, '0');
    default:
      // CPF, CNPJ, phone, CEP…: digits become zeros, separators stay ("000.000.000-00")
      return original.replace(/\d/g, '0');
  }
}

/** `text` with every piece of personal data replaced; null when there is none. */
export function replacePii(text: string): string | null {
  if (text.trim().length < MIN_LENGTH) return null;
  const spans = detectAll(text);
  if (spans.length === 0) return null;
  let out = '';
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start) + placeholderFor(span.kind, text.slice(span.start, span.end));
    at = span.end;
  }
  return out + text.slice(at);
}

/**
 * The tree is stored as written by the browser (entities not decoded): detection runs on the
 * decoded text, and a changed text goes back with `&` and `<` escaped.
 */
const reescape = (text: string, quotes: boolean): string => {
  const out = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return quotes ? out : out.replace(/>/g, '&gt;');
};

/** Replaces personal data in the text nodes and the text-bearing attributes of `root`, in place. */
export function scrubPersonalData(root: readonly HtmlNode[]): number {
  let replaced = 0;
  const visitText = (nodes: readonly HtmlNode[], parentTag: string) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        if (SKIP_PARENTS.has(parentTag)) continue;
        const next = replacePii(decodeEntities(node.text));
        if (next !== null) {
          node.text = reescape(next, false);
          replaced++;
        }
      } else if (node.type === 'element') {
        visitText(node.children, node.tag);
      }
    }
  };
  visitText(root, '');

  eachElement(root, (el) => {
    for (const attr of el.attrs) {
      const url = attr.name === 'href';
      if (!url && !TEXT_ATTRS.includes(attr.name)) continue;
      if (!attr.value || attr.value.length > MAX_ATTR_LENGTH || /^data:/i.test(attr.value))
        continue;
      const next = replacePii(decodeEntities(attr.value));
      if (next !== null) {
        // `"` is escaped by the serializer
        attr.value = reescape(next, true);
        replaced++;
      }
    }
  });
  return replaced;
}
