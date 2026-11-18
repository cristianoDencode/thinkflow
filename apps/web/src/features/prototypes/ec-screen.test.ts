import type { Component } from 'grapesjs';
import { describe, expect, it } from 'vitest';
import { CAPTURED_CSS, CAPTURED_HTML } from './captured-screen.fixture';
import {
  SCREEN_CATEGORY,
  buildScreenBlocks,
  componentMarkup,
  paletteLabel,
  structureSignature,
} from './ec-describe';
import {
  absorbRowWrapper,
  insertContent,
  isRowWrapper,
  isRowWrapperHtml,
  rowInsertionPoint,
  wrapRowHtml,
} from './ec-insert';
import { ecKindOf, tagOf } from './ec-model';
import { all, headlessEditor, html, ofKind } from './ec-test-utils';
import { blockContent } from './ecidade-blocks';

const captured = () => headlessEditor(CAPTURED_HTML, CAPTURED_CSS);
const rowsOf = (table: Component) =>
  all({ getWrapper: () => table } as never, (c) => tagOf(c) === 'tr');
const blockFor = (editor: ReturnType<typeof captured>, label: string) =>
  buildScreenBlocks(editor.getWrapper()!).find((b) => b.label === label)!;

describe('"Desta tela" palette', () => {
  it('has one block per distinct kind + structure, labelled by kind and first label', () => {
    const blocks = buildScreenBlocks(captured().getWrapper()!);
    expect(blocks.map((b) => b.label)).toEqual([
      'Título de janela (Consultas > Consulta Empenho)',
      'Grupo (Consulta Empenho)',
      'Lookup (Número do Empenho)', // the 2nd lookup has the same structure: deduped
      'Campo (Número do Processo)',
      'Data (intervalo)',
      'Combo (Situação)',
      'Barra de botões (Pesquisa, Limpar campos)',
      'Grade (Empenho, Credor, Valor)',
      'Barra de status (Instituição: Prefeitura de Exemplo)',
    ]);
    expect(blocks.map((b) => b.kind)).toEqual([
      'window-title',
      'fieldset',
      'lookup',
      'field',
      'date-range',
      'select',
      'button-bar',
      'grid',
      'status-bar',
    ]);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
    expect(blocks.every((b) => b.category === SCREEN_CATEGORY && b.css === '')).toBe(true);
  });

  it('keeps structurally different components of the same kind apart', () => {
    const editor = headlessEditor(
      '<div data-ec="field" class="a"><label data-ec-part="label">Um:</label><input data-ec-part="input" /></div>' +
        '<div data-ec="field" class="a"><label data-ec-part="label">Dois:</label><input data-ec-part="input" value="x" /></div>' +
        '<div data-ec="field" class="b"><label data-ec-part="label">Três:</label><input data-ec-part="input" /></div>',
    );
    expect(buildScreenBlocks(editor.getWrapper()!).map((b) => b.label)).toEqual([
      'Campo (Um)',
      'Campo (Três)',
    ]);
  });

  it('a grid with more rows is the same kind of grid', () => {
    const grid = (rows: number) =>
      `<table data-ec="grid"><thead><tr><th>A</th><th>B</th></tr></thead><tbody>${'<tr><td>1</td><td>2</td></tr>'.repeat(rows)}</tbody></table>`;
    const editor = headlessEditor(grid(2) + grid(5));
    expect(buildScreenBlocks(editor.getWrapper()!)).toHaveLength(1);
  });

  it('blocks insert the component with its original markup (no builtin classes added)', () => {
    const editor = captured();
    const lookup = blockFor(editor, 'Lookup (Número do Empenho)');
    expect(lookup.html).toContain('data-ec="lookup"');
    expect(lookup.html).toContain('class="rotulo"');
    expect(lookup.html).not.toMatch(/ec-(field|lookup|label)/);
    const bar = blockFor(editor, 'Barra de botões (Pesquisa, Limpar campos)');
    expect(bar.html.startsWith('<div data-ec="button-bar" class="barra">')).toBe(true);
  });

  it('row blocks come wrapped in a minimal table that keeps the original table attributes', () => {
    const editor = captured();
    const lookup = blockFor(editor, 'Lookup (Número do Empenho)');
    expect(
      lookup.html.startsWith(
        '<table cellspacing="0" cellpadding="1" border="0" class="layout"><tbody><tr data-ec="lookup">',
      ),
    ).toBe(true);
    expect(lookup.html.endsWith('</tr></tbody></table>')).toBe(true);
    expect(isRowWrapperHtml(lookup.html)).toBe(true);
    // a cell root (the window title <td>) gets its row too
    const title = blockFor(editor, 'Título de janela (Consultas > Consulta Empenho)');
    expect(title.html).toMatch(
      /^<table [^>]*class="janela"><tbody><tr><td data-ec="window-title" class="titulo">/,
    );
    expect(isRowWrapperHtml(title.html)).toBe(true);
    // non-row components are not wrapped
    expect(isRowWrapperHtml(blockFor(editor, 'Grupo (Consulta Empenho)').html)).toBe(false);
    expect(isRowWrapperHtml(blockFor(editor, 'Grade (Empenho, Credor, Valor)').html)).toBe(false);
  });

  it('labels use the label of the first component of the structure', () => {
    const editor = captured();
    const lookups = ofKind(editor, 'lookup', 1);
    expect(paletteLabel(lookups, 'lookup')).toBe('Lookup (Credor)');
    expect(paletteLabel(ofKind(editor, 'tabs', 0) ?? lookups, 'tabs')).toBeTypeOf('string');
  });

  it('structure signatures ignore texts and values, not tags or classes', () => {
    const a = '<div data-ec="field" class="x"><label>Um</label><input value="1" name="n1" /></div>';
    const b =
      '<div data-ec="field" class="x"><label>Dois</label><input value="2" name="n2" /></div>';
    const c =
      '<div data-ec="field" class="y"><label>Dois</label><input value="2" name="n2" /></div>';
    expect(structureSignature(a, 'field')).toBe(structureSignature(b, 'field'));
    expect(structureSignature(a, 'field')).not.toBe(structureSignature(c, 'field'));
  });

  it('an empty or unrecognized screen has no blocks', () => {
    expect(buildScreenBlocks(headlessEditor('<p>oi</p>').getWrapper()!)).toEqual([]);
  });
});

describe('inserting row components', () => {
  const rowBlock = (editor: ReturnType<typeof captured>) =>
    blockFor(editor, 'Campo (Número do Processo)');
  const layoutTable = (editor: ReturnType<typeof captured>) =>
    all(editor, (c) => c.getClasses().includes('layout'))[0]!;
  const kindsIn = (table: Component) =>
    rowsOf(table)
      .map((r) => ecKindOf(r))
      .filter(Boolean);

  it('into a table: the rows go after the selected row and the wrapper disappears', () => {
    const editor = captured();
    const block = rowBlock(editor);
    const table = layoutTable(editor);
    const firstRow = ofKind(editor, 'lookup', 0);
    const added = insertContent(editor.getWrapper()!, firstRow, blockContent(block), true);
    expect(added).toHaveLength(1);
    expect(tagOf(added[0]!)).toBe('tr');
    expect(kindsIn(table)).toEqual(['lookup', 'field', 'lookup', 'field', 'date-range', 'select']);
    expect(all(editor, (c) => c.getClasses().includes('layout'))).toHaveLength(1); // no extra table
    expect(added[0]!.parent()).toBe(firstRow.parent());
  });

  it('with `before`: a row goes right above the selected row, in the same tbody', () => {
    const editor = captured();
    const block = rowBlock(editor);
    const table = layoutTable(editor);
    const dates = ofKind(editor, 'date-range');
    const added = insertContent(editor.getWrapper()!, dates, blockContent(block), true, {
      before: true,
    });
    expect(added).toHaveLength(1);
    expect(added[0]!.parent()).toBe(dates.parent());
    expect(added[0]!.index()).toBe((dates.index() ?? 0) - 1);
    expect(kindsIn(table)).toEqual(['lookup', 'lookup', 'field', 'field', 'date-range', 'select']);
    expect(all(editor, (c) => c.getClasses().includes('layout'))).toHaveLength(1);
    // above the very first row too
    const first = ofKind(editor, 'lookup', 0);
    const [top] = insertContent(editor.getWrapper()!, first, blockContent(block), true, {
      before: true,
    });
    expect(top!.index()).toBe(0);
    expect(kindsIn(table)[0]).toBe('field');
  });

  it('with `before` on a cell, tbody, table or group: above its row / at the start of the body', () => {
    const editor = captured();
    const cell = ofKind(editor, 'select').components().models[1]!; // a <td>
    insertContent(editor.getWrapper()!, cell, blockContent(rowBlock(editor)), true, {
      before: true,
    });
    expect(kindsIn(layoutTable(editor))).toEqual([
      'lookup',
      'lookup',
      'field',
      'date-range',
      'field',
      'select',
    ]);
    for (const pick of [
      (e: ReturnType<typeof captured>) => layoutTable(e),
      (e: ReturnType<typeof captured>) => layoutTable(e).components().models[0]!, // tbody
      (e: ReturnType<typeof captured>) => ofKind(e, 'fieldset'),
    ]) {
      const other = captured();
      insertContent(other.getWrapper()!, pick(other), blockContent(rowBlock(other)), true, {
        before: true,
      });
      expect(kindsIn(layoutTable(other))[0]).toBe('field');
      expect(kindsIn(layoutTable(other))).toHaveLength(6);
    }
  });

  it("into a selected table, tbody or cell: at the end of the table / after the cell's row", () => {
    for (const pick of [
      (e: ReturnType<typeof captured>) => layoutTable(e),
      (e: ReturnType<typeof captured>) => layoutTable(e).components().models[0]!, // tbody
    ]) {
      const editor = captured();
      insertContent(editor.getWrapper()!, pick(editor), blockContent(rowBlock(editor)), true);
      expect(kindsIn(layoutTable(editor)).at(-1)).toBe('field');
      expect(kindsIn(layoutTable(editor))).toHaveLength(6);
    }
    const editor = captured();
    const cell = ofKind(editor, 'lookup', 0).components().models[1]!; // a <td>
    insertContent(editor.getWrapper()!, cell, blockContent(rowBlock(editor)), true);
    expect(kindsIn(layoutTable(editor))[1]).toBe('field');
  });

  it('into a group (fieldset): continues its layout table', () => {
    const editor = captured();
    insertContent(
      editor.getWrapper()!,
      ofKind(editor, 'fieldset'),
      blockContent(rowBlock(editor)),
      true,
    );
    expect(kindsIn(layoutTable(editor))).toHaveLength(6);
    expect(kindsIn(layoutTable(editor)).at(-1)).toBe('field');
  });

  it('outside a table: wrapped in a minimal table with the original table attributes', () => {
    const editor = captured();
    const before = all(editor, (c) => tagOf(c) === 'table').length;
    const added = insertContent(
      editor.getWrapper()!,
      undefined,
      blockContent(rowBlock(editor)),
      true,
    );
    expect(added).toHaveLength(1);
    const wrapper = added[0]!;
    expect(tagOf(wrapper)).toBe('table');
    expect(isRowWrapper(wrapper)).toBe(true);
    expect(wrapper.getClasses()).toEqual(['layout']);
    expect(wrapper.getAttributes()).toMatchObject({
      cellspacing: '0',
      cellpadding: '1',
      border: '0',
    });
    expect(wrapper.toHTML()).toContain('<tbody><tr data-ec="field">');
    expect(all(editor, (c) => tagOf(c) === 'table')).toHaveLength(before + 1);
    // it still gets the screen's own css: the class rules are the screen's
    expect(editor.getCss()).toContain('table.layout td.rotulo');
  });

  it('after a non-table leaf (a button bar): wrapped too, in its container', () => {
    const editor = captured();
    const bar = ofKind(editor, 'button-bar');
    const [wrapper] = insertContent(
      editor.getWrapper()!,
      bar,
      blockContent(rowBlock(editor)),
      true,
    );
    expect(tagOf(wrapper!)).toBe('table');
    expect(wrapper!.parent()).toBe(bar.parent());
    expect(wrapper!.index()).toBe((bar.index() ?? 0) + 1);
  });

  it('a wrapper dropped into a table body (native drag & drop) is absorbed', () => {
    const editor = captured();
    const table = layoutTable(editor);
    const tbody = table.components().models[0]!;
    const [wrapper] = tbody.append(blockContent(rowBlock(editor)), { at: 1 });
    expect(isRowWrapper(wrapper!)).toBe(true);
    const [row] = absorbRowWrapper(wrapper!);
    expect(tagOf(row!)).toBe('tr');
    expect(row!.parent()).toBe(tbody);
    expect(row!.index()).toBe(1);
    expect(kindsIn(table)).toHaveLength(6);
  });

  it('a wrapper dropped straight into a <table> goes to its last tbody', () => {
    const editor = captured();
    const table = layoutTable(editor);
    const [wrapper] = table.append(blockContent(rowBlock(editor)));
    const [row] = absorbRowWrapper(wrapper!);
    expect(row!.parent()).toBe(table.components().models[0]);
  });

  it('a wrapper dropped right after a layout table joins it; elsewhere it stays', () => {
    const editor = captured();
    const fieldset = ofKind(editor, 'fieldset');
    const [wrapper] = fieldset.append(blockContent(rowBlock(editor)));
    expect(absorbRowWrapper(wrapper!)[0]!.parent()).toBe(
      layoutTable(editor).components().models[0],
    );

    const other = captured();
    const [stays] = other.getWrapper()!.append(blockContent(rowBlock(other)));
    expect(absorbRowWrapper(stays!)).toEqual([stays]);
  });

  it('non-row blocks keep the generic placement (into a container / after a leaf)', () => {
    const editor = captured();
    const bar = blockFor(editor, 'Barra de botões (Pesquisa, Limpar campos)');
    const [added] = insertContent(editor.getWrapper()!, undefined, blockContent(bar), false);
    expect(added!.get('type')).toBe('ec-buttons');
    expect(added!.parent()).toBe(editor.getWrapper());
    const grid = ofKind(editor, 'grid');
    const [afterGrid] = insertContent(editor.getWrapper()!, grid, blockContent(bar), false);
    expect(afterGrid!.index()).toBe((grid.index() ?? 0) + 1);
  });

  it('non-row blocks with `before`: above a leaf, as the first child of a container', () => {
    const editor = captured();
    const bar = blockFor(editor, 'Barra de botões (Pesquisa, Limpar campos)');
    const grid = ofKind(editor, 'grid');
    const at = grid.index() ?? 0;
    const [above] = insertContent(editor.getWrapper()!, grid, blockContent(bar), false, {
      before: true,
    });
    expect(above!.parent()).toBe(grid.parent());
    expect(above!.index()).toBe(at);
    expect(grid.index()).toBe(at + 1);
    // a selected container: first child (without `before`: last)
    const fieldset = ofKind(editor, 'fieldset');
    const [first] = insertContent(editor.getWrapper()!, fieldset, blockContent(bar), false, {
      before: true,
    });
    expect(first!.parent()).toBe(fieldset);
    expect(first!.index()).toBe(0);
    // nothing selected: the end of the page, as always
    const [end] = insertContent(editor.getWrapper()!, undefined, blockContent(bar), false, {
      before: true,
    });
    expect(end!.parent()).toBe(editor.getWrapper());
  });

  it('rowInsertionPoint is null outside table contexts', () => {
    const editor = captured();
    expect(rowInsertionPoint(ofKind(editor, 'button-bar'))).toBeNull();
    expect(rowInsertionPoint(ofKind(editor, 'grid'))).not.toBeNull();
    expect(rowInsertionPoint(ofKind(editor, 'button-bar'), true)).toBeNull();
    // before: the index of the row itself (after: the next one)
    const row = ofKind(editor, 'date-range');
    expect(rowInsertionPoint(row)).toEqual({ parent: row.parent(), at: (row.index() ?? 0) + 1 });
    expect(rowInsertionPoint(row, true)).toEqual({ parent: row.parent(), at: row.index() });
    // a header row: its rows are absorbed by the body (above it = the start of the body)
    const headRow = all(editor, (c) => tagOf(c) === 'tr' && tagOf(c.parent()!) === 'thead')[0]!;
    const body = all(
      editor,
      (c) => tagOf(c) === 'tbody' && c.parent() === ofKind(editor, 'grid'),
    )[0]!;
    expect(rowInsertionPoint(headRow, true)).toEqual({ parent: body, at: 0 });
    expect(rowInsertionPoint(headRow)).toEqual({ parent: body });
  });

  it('the markup of a row component is wrapped on export too (save to "Meus blocos")', () => {
    const editor = captured();
    const markup = componentMarkup(ofKind(editor, 'select'));
    expect(markup.startsWith('<table')).toBe(true);
    expect(isRowWrapperHtml(markup)).toBe(true);
    expect(
      wrapRowHtml('<tr data-ec="field"></tr>', 'tr', { class: 'a b', id: 'x', 'on-x': '1' }),
    ).toBe('<table class="a b"><tbody><tr data-ec="field"></tr></tbody></table>');
    // the wrapped html is exactly what is inserted again
    const copy = captured();
    insertContent(copy.getWrapper()!, ofKind(copy, 'field'), markup, isRowWrapperHtml(markup));
    expect(all(copy, (c) => c.getAttributes()['data-ec'] === 'select')).toHaveLength(2);
    expect(html(ofKind(copy, 'select', 1))).toContain('<option value="0">Todas</option>');
  });
});
