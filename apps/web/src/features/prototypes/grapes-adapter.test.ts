import grapesjs, { type Editor } from 'grapesjs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CAPTURED_CSS, CAPTURED_HTML } from './captured-screen.fixture';
import type { PrototypeBlockDto } from '@thinkflow/shared';
import type { EditorAdapter, EditorMount } from './editor-adapter';
import { createGrapesAdapter } from './grapes-adapter';

let host: HTMLElement;
let adapter: EditorAdapter;
let mount: EditorMount;
let onFavorite: Mock<(block: { label: string; html: string; css: string }) => void>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  const el = () => host.appendChild(document.createElement('div'));
  onFavorite = vi.fn<(block: { label: string; html: string; css: string }) => void>();
  mount = {
    canvas: el(),
    blocks: el(),
    layers: el(),
    styles: el(),
    traits: el(),
    onSave: () => {},
    onFavorite,
  };
  adapter = createGrapesAdapter(mount);
  adapter.load({ html: CAPTURED_HTML, css: CAPTURED_CSS, width: 1280, height: 720 });
});
afterEach(() => {
  adapter.destroy();
  host.remove();
});

const tiles = () =>
  Array.from(mount.blocks.querySelectorAll('[data-proto-block]')).map((t) => ({
    id: t.getAttribute('data-proto-block')!,
    name: t.querySelector('.proto-block-name')?.textContent,
  }));

/** A click on a palette tile inserts its block (the shortcut to drag and drop). */
const clickTile = (name: string) => {
  const id = tiles().find((t) => t.name === name)!.id;
  mount.blocks
    .querySelector(`[data-proto-block="${id}"]`)!
    .closest<HTMLElement>('.gjs-block')!
    .click();
};

describe('grapes adapter: captured components', () => {
  it('offers the components of this screen in their own palette category, first', () => {
    const screen = tiles().filter((t) => t.id.startsWith('screen-'));
    expect(screen.map((t) => t.name)).toContain('Lookup (Número do Empenho)');
    expect(screen.map((t) => t.name)).toContain('Grade (Empenho, Credor, Valor)');
    expect(mount.blocks.textContent).toContain('Desta tela');
    expect(tiles()[0]!.id.startsWith('screen-')).toBe(true);
    // built-in blocks are still there
    expect(tiles().some((t) => t.id === 'ec-lookup')).toBe(true);
  });

  it('keeps the exported HTML plain (data-ec kept, no editor flags)', () => {
    const { html, css } = adapter.getSnapshot();
    expect(html).toContain('data-ec="lookup"');
    expect(html).toContain('data-ec-part="label"');
    expect(html).not.toMatch(/selectable|hoverable|layerable/);
    expect(css).toContain('table.layout td.rotulo');
  });

  it('inserts a row block outside a table wrapped (keeping the table look) and selects the row', () => {
    clickTile('Campo (Número do Processo)');
    const { html } = adapter.getSnapshot();
    expect(html.match(/<tr data-ec="field"/g)).toHaveLength(2);
    expect(html).toMatch(/<\/form><table[^>]*class="layout"[^>]*><tbody><tr data-ec="field"/);
    expect(adapter.getState().selection).toBe('Campo: Número do Processo');
  });

  it('with a row selected, a row block joins its table', () => {
    clickTile('Campo (Número do Processo)'); // selects the new row (inside its wrapper table)
    clickTile('Combo (Situação)'); // goes after the selected row, in that table
    const { html } = adapter.getSnapshot();
    expect(html.match(/<table[^>]*class="layout"/g)).toHaveLength(2); // original + one wrapper
    const second = html.slice(html.lastIndexOf('<table'));
    expect(second.match(/data-ec="field"/g)).toHaveLength(1);
    expect(second.match(/data-ec="select"/g)).toHaveLength(1);
  });

  it('saves the selected component with only the css that styles it', () => {
    clickTile('Combo (Situação)');
    const saved = adapter.getSelectionAsBlock()!;
    expect(saved.label).toBe('Combo: Situação');
    expect(saved.html).toMatch(/^<table[^>]*class="layout"><tbody><tr data-ec="select">/);
    expect(saved.css).toContain('table.layout td.rotulo{width:140px;text-align:right}');
    expect(saved.css).toContain('.in{border:1px solid #999999;background:#ffffff}');
    expect(saved.css).not.toContain('.grade');
    expect(saved.css).not.toContain('.rodape');
  });

  it('a block saved that way can be inserted again in another screen', () => {
    clickTile('Combo (Situação)');
    const saved = adapter.getSelectionAsBlock()!;
    adapter.load({ html: '<body><p>Outra tela</p></body>', css: '', width: 800, height: 600 });
    adapter.insertBlock(saved);
    const { html, css } = adapter.getSnapshot();
    expect(html).toContain('data-ec="select"');
    expect(css).toContain('table.layout td.rotulo');
  });

  it('escapes the labels of the palette tiles (they come from a captured page)', () => {
    adapter.load({
      html: '<body><div data-ec="field"><label data-ec-part="label">&lt;img src=x onerror=alert(1)&gt;</label><input data-ec-part="input" /></div></body>',
      css: '',
      width: 800,
      height: 600,
    });
    expect(mount.blocks.querySelector('img')).toBeNull();
    expect(tiles().find((t) => t.id.startsWith('screen-'))!.name).toContain('<img src=x');
  });

  it('reloading another screen replaces the "Desta tela" blocks', () => {
    adapter.load({
      html: '<body><div data-ec="field"><label data-ec-part="label">Só:</label><input data-ec-part="input" /></div></body>',
      css: '',
      width: 800,
      height: 600,
    });
    expect(
      tiles()
        .filter((t) => t.id.startsWith('screen-'))
        .map((t) => t.name),
    ).toEqual(['Campo (Só)']);
  });
});

/** Captured css as seen live: percent / viewport heights all the way down. */
const GROWING_CSS = `html,body{height:100%;margin:0}
#sistema{height:100%;min-height:100vh}
#quadro-corpo{height:100vh}`;
const GROWING_HTML =
  '<body><div id="sistema"><div id="quadro-corpo" class="quadro"><div data-tf-frame="1" style="display:inline-block;width:1914px;height:837px">Corpo</div></div></div></body>';

/** The GrapesJS editor behind the adapter (jsdom renders no canvas iframe, the models are enough). */
const engine = async () => {
  const init = vi.spyOn(grapesjs, 'init');
  const fresh = createGrapesAdapter({
    canvas: document.createElement('div'),
    blocks: document.createElement('div'),
    layers: document.createElement('div'),
    styles: document.createElement('div'),
    traits: document.createElement('div'),
    onSave: () => {},
  });
  const editor = init.mock.results[0]!.value as Editor;
  init.mockRestore();
  await vi.waitFor(() => expect(editor.Canvas.getFrame()).toBeTruthy());
  return { editor, fresh };
};

describe('grapes adapter: fixed frame size (no infinite growth)', () => {
  it('never lets the canvas frame follow the content height', async () => {
    const { editor, fresh } = await engine();
    fresh.load({ html: GROWING_HTML, css: GROWING_CSS, width: 1914, height: 857 });
    const frame = editor.Canvas.getFrame();
    // GrapesJS auto-sizes the frame of an infinite canvas to the content: that must be off
    expect(frame.hasAutoHeight()).toBe(false);
    expect(frame.get('width')).toBe('1914px');
    expect(frame.get('height')).toBe('857px');
    // content taller than the page (or css tied to the frame height) does not change it
    fresh.insertBlock({ html: '<div style="height:3000px">alto</div>', css: '' });
    expect(frame.hasAutoHeight()).toBe(false);
    expect(frame.get('height')).toBe('857px');
    fresh.setFrameSize(1000, 500);
    expect(frame.hasAutoHeight()).toBe(false);
    expect(frame.get('width')).toBe('1000px');
    expect(frame.get('height')).toBe('500px');
    // style edits are plain rules, never wrapped in a media query tied to the first frame width
    expect(editor.Devices.get('prototype')!.getWidthMedia()).toBe('');
    expect(editor.getModel().getCurrentMedia()).toBe('');
    // reloading another screen keeps it fixed too
    fresh.load({ html: GROWING_HTML, css: GROWING_CSS, width: 1366, height: 768 });
    expect(frame.hasAutoHeight()).toBe(false);
    expect(frame.get('height')).toBe('768px');
    fresh.destroy();
  });

  it('keeps the captured css out of the css composer (only the editor rules live there)', async () => {
    const { editor, fresh } = await engine();
    const rules = Array.from({ length: 400 }, (_, i) => `.c${i}{color:#00${(i % 90) + 10}ff}`).join(
      '',
    );
    fresh.load({ html: GROWING_HTML, css: GROWING_CSS + rules, width: 800, height: 600 });
    expect(editor.Css.getAll().length).toBeLessThan(5); // not the 400 captured rules
    expect(editor.getCss()).not.toContain('.c399');
    // ...and it still round-trips in full through the saved snapshot
    const { css } = fresh.getSnapshot();
    expect(css).toContain('html,body{height:100%');
    expect(css).toContain('.c399{');
    // the base comes first; whatever follows the marker (inline styles turned into rules) is small
    expect(css.split('/* tf-edits */')[1] ?? '').not.toContain('.c399');
    fresh.destroy();
  });

  it('saves base + edits around the marker and loads them back separately', async () => {
    const { editor, fresh } = await engine();
    const withEdits = `${GROWING_CSS}\n/* tf-edits */\n.quadro{color:#ff0000;}`;
    fresh.load({ html: GROWING_HTML, css: withEdits, width: 800, height: 600 });
    // only the edits were parsed into the composer
    expect(editor.getCss()).toContain('.quadro{color:#ff0000');
    expect(editor.getCss()).not.toContain('#quadro-corpo{height:100vh}');
    const saved = fresh.getSnapshot().css;
    const [base, edits] = saved.split('/* tf-edits */');
    expect(base).toContain('#quadro-corpo{height:100vh}');
    expect(base).not.toContain('.quadro{color:#ff0000');
    expect(edits).toContain('.quadro{color:#ff0000;}');
    expect(fresh.getState().dirty).toBe(false);
    fresh.destroy();
  });

  it('a component saved to "Meus blocos" gets its rules from the base css', () => {
    clickTile('Combo (Situação)');
    const saved = adapter.getSelectionAsBlock()!;
    expect(saved.css).toContain('table.layout td.rotulo{width:140px;text-align:right}');
    expect(adapter.getSnapshot().css).toContain('.nunca-usada');
  });
});

/* ---- favorites ------------------------------------------------------------------------------ */

const favoriteBlock = (over: Partial<PrototypeBlockDto> = {}): PrototypeBlockDto => ({
  id: 'f1',
  name: 'Lookup de empenho',
  category: 'e-Cidade',
  html: '<table class="layout"><tbody><tr data-ec="lookup"><td class="rotulo" data-ec-part="label"><b>Empenho:</b></td><td><input class="in" data-ec-part="input" type="text" value="" /></td></tr></tbody></table>',
  css: 'td{padding:0}\ninput{border:1px solid #ff0000}\ntable.layout td.rotulo{width:140px}',
  source: 'Favorito de Consulta Empenho',
  createdAt: 1,
  ...over,
});

const tileEl = (id: string) =>
  mount.blocks
    .querySelector<HTMLElement>(`[data-proto-block="${id}"]`)!
    .closest<HTMLElement>('.gjs-block')!;

describe('grapes adapter: favorites', () => {
  it('every "Desta tela" tile has a star that saves the component without inserting it', () => {
    const before = adapter.getSnapshot().html;
    const stars = Array.from(mount.blocks.querySelectorAll<HTMLElement>('[data-proto-fav]'));
    expect(stars.length).toBeGreaterThan(3);
    // built-in tiles have no star
    expect(mount.blocks.querySelector('[data-proto-block="ec-field"] [data-proto-fav]')).toBeNull();
    const lookup = mount.blocks.querySelector<HTMLElement>(
      `[data-proto-block^="screen-"] .proto-block-name`,
    )!;
    expect(lookup).toBeTruthy();
    const star = Array.from(stars).find((b) =>
      b.getAttribute('aria-label')?.includes('Lookup (Número do Empenho)'),
    )!;
    expect(star.getAttribute('aria-label')).toBe('Favoritar na paleta: Lookup (Número do Empenho)');
    expect(star.getAttribute('title')).toBe('Favoritar na paleta');
    star.click();
    expect(onFavorite).toHaveBeenCalledTimes(1);
    const saved = onFavorite.mock.calls[0]![0] as { label: string; html: string; css: string };
    expect(saved.label).toBe('Lookup: Número do Empenho');
    // markup keeps the markers; css is the subset of the screen's base rules the component needs
    expect(saved.html).toMatch(/^<table[^>]*class="layout"><tbody><tr data-ec="lookup"/);
    expect(saved.html).toContain('data-ec-part="label"');
    expect(saved.css).toContain('table.layout td.rotulo{width:140px;text-align:right}');
    expect(saved.css).toContain('.in{border:1px solid #999999;background:#ffffff}');
    expect(saved.css).not.toContain('.grade');
    // nothing was inserted
    expect(adapter.getSnapshot().html).toBe(before);
  });

  it('reports the kind of the selection (the toolbar star is for recognized components)', () => {
    expect(adapter.getState().selectionKind).toBeNull();
    clickTile('Combo (Situação)');
    expect(adapter.getState().selectionKind).toBe('select');
    adapter.run('deselect');
    expect(adapter.getState().selectionKind).toBeNull();
  });

  it('favorites join the built-in e-Cidade palette category, marked with a star and their source', () => {
    adapter.setUserBlocks([
      favoriteBlock(),
      favoriteBlock({ id: 'm1', name: 'Meu bloco', category: 'Meus blocos', source: null }),
    ]);
    const favorite = tiles().find((t) => t.name === 'Lookup de empenho')!;
    expect(favorite.id).toBe('user-f1');
    const category = tileEl('user-f1').closest('.gjs-block-category')!;
    expect(category.textContent).toContain('e-Cidade');
    // the built-in e-Cidade blocks live in the same category
    expect(category.querySelector('[data-proto-block="ec-field"]')).toBeTruthy();
    expect(tileEl('user-f1').querySelector('.proto-block-ico')!.textContent).toBe('⭐');
    expect(tileEl('user-f1').getAttribute('title')).toBe('Favorito de Consulta Empenho');
    // other user blocks stay in their own category, with the plain star
    const mine = tileEl('user-m1');
    expect(mine.closest('.gjs-block-category')!.textContent).toContain('Meus blocos');
    expect(mine.closest('.gjs-block-category')).not.toBe(category);
    // removing the favorites removes the tiles
    adapter.setUserBlocks([]);
    expect(tiles().some((t) => t.id.startsWith('user-'))).toBe(false);
  });

  /** The edit-rule part of the saved css (what follows the marker). */
  const edits = () => adapter.getSnapshot().css.split('/* tf-edits */')[1] ?? '';
  const base = () => adapter.getSnapshot().css.split('/* tf-edits */')[0]!;

  it('inserting a favorite adds its css to the edit rules (never the base), scoped to the component', () => {
    adapter.load({
      html: '<body><table class="outra"><tbody><tr><td id="fora">célula</td></tr></tbody></table><input id="campo-fora"></body>',
      css: '.outra td{color:#111111}',
      width: 800,
      height: 600,
    });
    adapter.setUserBlocks([favoriteBlock()]);
    clickTile('Lookup de empenho');

    const { html } = adapter.getSnapshot();
    expect(html).toContain('data-ec="lookup"');
    expect(html).toContain('data-ec-fav="f1"');
    expect(html.match(/data-ec-fav=/g)).toHaveLength(1);
    // base untouched, favorite css in the edits and scoped
    expect(base().trim()).toBe('.outra td{color:#111111}');
    expect(edits()).not.toBe('');
    for (const original of [
      'td{padding:0}',
      'input{border:1px solid #ff0000}',
      'table.layout td.rotulo{width:140px}',
    ]) {
      expect(edits()).not.toContain(`\n${original}`);
      expect(edits()).toContain(`:is(${original.split('{')[0]})`);
    }
    // generic selectors (td, input) reach only the inserted component, not the rest of the page
    const doc = document.implementation.createHTMLDocument('t');
    doc.body.innerHTML = html;
    const rules = edits()
      .split('}')
      .map((r) => r.split('{')[0]!.trim())
      .filter(Boolean);
    const hits = (selector: string) => Array.from(doc.querySelectorAll(selector));
    const tdRule = rules.find((r) => r.endsWith(':is(td)'))!;
    const inputRule = rules.find((r) => r.endsWith(':is(input)'))!;
    expect(hits(tdRule).map((el) => el.id)).toEqual(['', '']); // the two cells of the favorite
    expect(hits(tdRule).some((el) => el.id === 'fora')).toBe(false);
    expect(hits(inputRule).map((el) => el.id)).not.toContain('campo-fora');
    expect(hits(inputRule)).toHaveLength(1);
  });

  it('a favorite dropped in a table keeps its rules tied to the row that moved there', () => {
    adapter.load({
      html: '<body><table class="layout"><tbody><tr data-ec="field" id="linha"><td>a</td></tr></tbody></table></body>',
      css: '',
      width: 800,
      height: 600,
    });
    adapter.setUserBlocks([favoriteBlock()]);
    clickTile('Campo');
    clickTile('Lookup de empenho');
    const { html } = adapter.getSnapshot();
    // the wrapper table dissolved: the favorite's row itself carries the scope
    expect(html).toMatch(/<tr data-ec="lookup"[^>]*data-ec-fav="f1"/);
    expect(edits()).toContain('[data-ec-fav="f1"]');
  });

  it('a component that came from a favorite is saved again without the scope', () => {
    adapter.setUserBlocks([favoriteBlock()]);
    clickTile('Lookup de empenho');
    expect(adapter.getSnapshot().html).toContain('data-ec-fav="f1"');
    const saved = adapter.getSelectionAsBlock()!;
    expect(saved.html).not.toContain('data-ec-fav');
    expect(saved.css).not.toContain('data-ec-fav');
    expect(saved.css).toContain('input{border:1px solid #ff0000;}');
    expect(saved.css).toContain('td{padding:0;}');
  });
});

describe('grapes adapter: moving and positioning the selection', () => {
  const TABLE = `<body><table class="layout"><tbody>
<tr data-ec="lookup"><td class="rotulo" data-ec-part="label">Um</td><td><input data-ec-part="input" name="a"></td></tr>
<tr data-ec="select"><td class="rotulo" data-ec-part="label">Dois</td><td><select data-ec-part="input" name="b"><option>x</option></select></td></tr>
</tbody></table></body>`;
  /** `data-ec` kinds of the rows, in document order. */
  const kinds = () =>
    Array.from(adapter.getSnapshot().html.matchAll(/<tr data-ec="([\w-]+)"/g)).map((m) => m[1]);
  const loadTable = () => adapter.load({ html: TABLE, css: '', width: 800, height: 600 });
  const tileOf = (name: string) =>
    mount.blocks
      .querySelector(`[data-proto-block="${tiles().find((t) => t.name === name)!.id}"]`)!
      .closest<HTMLElement>('.gjs-block')!;
  /** A row block as the palette holds it: the row in a minimal table. */
  const rowBlock = (kind: string) => ({
    html: `<table class="layout"><tbody><tr data-ec="${kind}"><td data-ec-part="label">Novo</td><td><input data-ec-part="input" name="n"></td></tr></tbody></table>`,
    css: '',
  });
  /** Loads the table and adds a date-range row at its end; that row is the selection. */
  const selectNewRow = () => {
    loadTable();
    adapter.insertBlock(rowBlock('date-range'));
    expect(kinds()).toEqual(['lookup', 'select', 'date-range']);
  };

  it('Shift + click on a tile inserts above the selection; a plain click inserts below', () => {
    selectNewRow();
    tileOf('Lookup (Um)').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(kinds()).toEqual(['lookup', 'select', 'lookup', 'date-range']);
    expect(adapter.getState().selectionKind).toBe('lookup'); // the new row is selected
    clickTile('Combo (Dois)'); // plain click: right below the selected row
    expect(kinds()).toEqual(['lookup', 'select', 'lookup', 'select', 'date-range']);
    expect(adapter.getSnapshot().html.match(/<table/g)).toHaveLength(1);
  });

  it('insertBlock({ before }) puts a lookup row above the selected one in the same tbody', () => {
    selectNewRow();
    const block = rowBlock('lookup');
    adapter.insertBlock(block, { before: true });
    expect(kinds()).toEqual(['lookup', 'select', 'lookup', 'date-range']);
    expect(adapter.getSnapshot().html.match(/<table/g)).toHaveLength(1);
    adapter.insertBlock(block); // default: below the selected (new) row
    expect(kinds()).toEqual(['lookup', 'select', 'lookup', 'lookup', 'date-range']);
  });

  it('move-up / move-down move the selected row one position, keep it selected', () => {
    selectNewRow();
    adapter.run('move-up');
    expect(kinds()).toEqual(['lookup', 'date-range', 'select']);
    expect(adapter.getState().selectionKind).toBe('date-range');
    adapter.run('move-up');
    adapter.run('move-up'); // at the top: no-op
    expect(kinds()).toEqual(['date-range', 'lookup', 'select']);
    adapter.run('move-down');
    expect(kinds()).toEqual(['lookup', 'date-range', 'select']);
    expect(adapter.getState().selectionKind).toBe('date-range');
    expect(adapter.getState().canUndo).toBe(true);
  });

  it('move-up / move-down do nothing without a selection', () => {
    selectNewRow();
    adapter.run('deselect');
    adapter.run('move-up');
    adapter.run('move-down');
    expect(kinds()).toEqual(['lookup', 'select', 'date-range']);
    expect(adapter.getState().selection).toBeNull();
  });

  it('reports a free-move offset in the state and "reset-offset" removes it', async () => {
    selectNewRow();
    expect(adapter.getState().selectionOffset).toBe(false);
    const seen: boolean[] = [];
    adapter.subscribe((s) => seen.push(s.selectionOffset));
    // the same nudge the arrow keys do
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );
    expect(adapter.getState().selectionOffset).toBe(true);
    expect(seen.at(-1)).toBe(true);
    expect(adapter.getSnapshot().css).toContain('translateX(10px)');
    await new Promise((r) => setTimeout(r, 5));
    adapter.run('reset-offset');
    expect(adapter.getState().selectionOffset).toBe(false);
    expect(seen.at(-1)).toBe(false);
    expect(adapter.getSnapshot().css).not.toContain('transform');
    // undo brings the offset back, and the state follows
    adapter.run('undo');
    expect(adapter.getState().selectionOffset).toBe(true);
    // nothing selected: no offset, reset is a no-op
    adapter.run('deselect');
    expect(adapter.getState().selectionOffset).toBe(false);
    adapter.run('reset-offset');
  });
});
