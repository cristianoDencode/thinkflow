import { TEST_LIMITS, type TestLocator, type TestTarget } from '@thinkflow/shared';
import type { ElementFacts } from './recorder-events';

/** Best first: what survives layout changes and reads well in a spec. */
const PRIORITY: Record<TestLocator['kind'], number> = {
  testid: 0,
  role: 1,
  label: 2,
  placeholder: 3,
  alt: 4,
  title: 5,
  text: 6,
  css: 7,
};

/** Generated ids and classes (`#input-3f9a1c`, `:r12:`, `ember123`) break on the next build. */
export function isUnstableId(id: string): boolean {
  return (
    /\d{3,}/.test(id) ||
    /[0-9a-f]{6,}/i.test(id) ||
    /^:r[0-9a-z]+:$/.test(id) ||
    /^(ember|ext-gen|react-select|mui-|headlessui-)/i.test(id)
  );
}

const isCssId = (l: TestLocator): boolean => l.kind === 'css' && /^#[^\s>+~.[:]+$/.test(l.selector);

/**
 * Orders the candidates found in the page: unique matches first (by kind priority), then the ones
 * that match a few elements (still useful as a fallback), never the ones that match nothing.
 * A CSS id that looks generated goes to the end.
 */
export function rankLocators(candidates: ElementFacts['candidates']): TestLocator[] {
  const seen = new Set<string>();
  const usable = candidates.filter((c) => {
    if (c.count < 1) return false;
    const key = JSON.stringify(c.locator);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const score = (c: (typeof usable)[number]) => {
    const unstable =
      isCssId(c.locator) && isUnstableId((c.locator as { selector: string }).selector.slice(1));
    return (c.count === 1 ? 0 : 100) + (unstable ? 50 : 0) + PRIORITY[c.locator.kind];
  };
  return usable
    .sort((a, b) => score(a) - score(b))
    .slice(0, TEST_LIMITS.maxLocators)
    .map((c) => c.locator);
}

const ROLE_NOUNS: Record<string, string> = {
  button: 'botão',
  link: 'link',
  textbox: 'campo',
  searchbox: 'campo de busca',
  checkbox: 'caixa',
  radio: 'opção',
  combobox: 'lista',
  listbox: 'lista',
  option: 'opção',
  tab: 'aba',
  menuitem: 'item de menu',
  switch: 'chave',
  heading: 'título',
  img: 'imagem',
  row: 'linha',
  cell: 'célula',
  status: 'mensagem',
  alert: 'alerta',
  dialog: 'janela',
};

const TEXT_TAGS = new Set([
  'p',
  'span',
  'li',
  'td',
  'th',
  'label',
  'strong',
  'em',
  'small',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** pt-BR, for people: `campo "E-mail"`, `botão "Entrar"`. */
export function describeElement(facts: ElementFacts): string {
  const noun =
    (facts.role && ROLE_NOUNS[facts.role]) ??
    (facts.tag === 'input' || facts.tag === 'textarea'
      ? 'campo'
      : facts.tag === 'select'
        ? 'lista'
        : facts.tag === 'a'
          ? 'link'
          : facts.tag === 'button'
            ? 'botão'
            : TEXT_TAGS.has(facts.tag)
              ? 'texto'
              : 'elemento');
  const label = (facts.label || facts.name).replace(/\s+/g, ' ').trim();
  return label ? `${noun} "${clip(label)}"` : noun;
}

/**
 * A target that can only be the page background (`html`/`body`): the user clicked empty space,
 * e.g. to focus the window. On some desktops `html` has no height, so replaying it would wait for
 * visibility forever. Such clicks are never recorded and, in older recordings, replay as no-ops.
 */
export function isEmptySpaceTarget(target: Pick<TestTarget, 'locators'> | null): boolean {
  if (!target || target.locators.length === 0) return false;
  return target.locators.every(
    (l) => l.kind === 'css' && /^(html|body|html\s*>\s*body)$/i.test(l.selector.trim()),
  );
}
