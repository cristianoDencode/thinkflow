import grapesjs, { type Component, type Editor } from 'grapesjs';
import { registerEcidadeTypes } from './grapes-ecidade-types';
import { prepareSnapshot, splitBody } from './sanitize';

/** Test helpers: a headless GrapesJS (no canvas) with the e-Cidade types, loaded like the adapter does. */
export function headlessEditor(html = '', css = ''): Editor {
  const editor = grapesjs.init({
    headless: true,
    storageManager: false,
    container: document.createElement('div'),
    fromElement: false,
    protectedCss: '',
  } as never);
  registerEcidadeTypes(editor);
  load(editor, html, css);
  return editor;
}

export function load(editor: Editor, html: string, css = ''): void {
  const prepared = prepareSnapshot(html.startsWith('<body') ? html : `<body>${html}</body>`, css);
  editor.setStyle(prepared.css);
  editor.setComponents(splitBody(prepared.html).inner);
}

export function all(editor: Editor, pred: (c: Component) => boolean): Component[] {
  const out: Component[] = [];
  const visit = (c: Component) => {
    (c.components() as unknown as { models: Component[] }).models.forEach((child) => {
      if (pred(child)) out.push(child);
      visit(child);
    });
  };
  visit(editor.getWrapper()!);
  return out;
}

/** First component with the given `data-ec` kind. */
export const ofKind = (editor: Editor, kind: string, index = 0): Component =>
  all(editor, (c) => c.getAttributes()['data-ec'] === kind)[index]!;

/** Reads / writes a trait the way the Propriedades panel does. */
export function trait(component: Component, name: string) {
  const t = component.getTrait(name);
  if (!t) throw new Error(`trait ${name} not found on ${component.get('type')}`);
  return {
    get: () => t.getValue() as string | number,
    set: (value: string | number) => t.setValue(value as never),
  };
}

export const traitNames = (component: Component): string[] =>
  (component.getTraits() as unknown as { get(k: string): string }[]).map((t) => t.get('name'));

/** Exported HTML of a component, whitespace-normalized. */
export const html = (c: Component) => c.toHTML().replace(/[ \t\r\n]+/g, ' ');
