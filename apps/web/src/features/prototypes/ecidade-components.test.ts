import { describe, expect, it } from 'vitest';
import { ECIDADE_COMPONENT_KINDS } from '@thinkflow/shared';
import { CAPTURED_CSS, CAPTURED_HTML } from './captured-screen.fixture';
import { applyUnits, enterPart, lockedChain, unitRootOf } from './ec-units';
import { KIND_TYPE, ecKindOf } from './ec-model';
import { all, headlessEditor, html, ofKind, trait, traitNames } from './ec-test-utils';
import { ECIDADE_BLOCKS } from './ecidade-blocks';

const captured = () => headlessEditor(CAPTURED_HTML, CAPTURED_CSS);
const block = (id: string) => ECIDADE_BLOCKS.find((b) => b.id === id)!.html;
const built = (id: string) => {
  const editor = headlessEditor(block(id));
  return editor.getWrapper()!.components().models[0]!;
};

describe('recognition', () => {
  it.each(ECIDADE_COMPONENT_KINDS)('data-ec="%s" becomes the %s component type', (kind) => {
    const editor = headlessEditor(`<div data-ec="${kind}"><span>x</span></div>`);
    const root = editor.getWrapper()!.components().models[0]!;
    expect(root.get('type')).toBe(KIND_TYPE[kind]);
    expect(ecKindOf(root)).toBe(kind);
  });

  it('works on any tag: a table row, a table, a fieldset, an input', () => {
    const editor = headlessEditor(
      '<table><tr data-ec="lookup"><td>a</td></tr></table><input data-ec="button" type="button" value="Ok" />',
    );
    expect(all(editor, (c) => c.get('type') === 'ec-lookup')[0]!.get('tagName')).toBe('tr');
    expect(all(editor, (c) => c.get('type') === 'ec-btn')[0]!.get('tagName')).toBe('input');
  });

  it('the attribute wins over the classes; an unknown attribute falls back to them', () => {
    const editor = headlessEditor(
      '<div class="ec-field" data-ec="lookup"></div><div class="ec-field" data-ec="nope"></div><div class="ec-grid"></div><span class="ec-btn"></span>',
    );
    const types = editor
      .getWrapper()!
      .components()
      .models.map((c) => c.get('type'));
    // ec-btn only on a <button>: a span stays a plain element
    expect(types.slice(0, 3)).toEqual(['ec-lookup', 'ec-field', 'ec-grid']);
    expect(String(types[3] ?? '')).not.toMatch(/^ec-/);
  });

  it.each(ECIDADE_BLOCKS)('built-in block $id carries data-ec and is recognized by it', (b) => {
    const root = new DOMParser().parseFromString(b.html, 'text/html').body.firstElementChild!;
    const kind = root.getAttribute('data-ec');
    expect(ECIDADE_COMPONENT_KINDS).toContain(kind);
    const model = built(b.id);
    expect(model.get('type')).toBe(KIND_TYPE[kind as keyof typeof KIND_TYPE]);
    // legacy screens (classes only, no attributes) are still recognized
    const legacy = headlessEditor(b.html.replace(/ data-ec(-part)?="[^"]*"/g, ''));
    expect(legacy.getWrapper()!.components().models[0]!.get('type')).toBe(model.get('type'));
  });

  it('recognizes the whole captured screen', () => {
    const editor = captured();
    const kinds = all(editor, (c) => Boolean(ecKindOf(c))).map((c) => ecKindOf(c));
    expect(kinds).toEqual([
      'window-title',
      'fieldset',
      'lookup',
      'lookup',
      'field',
      'date-range',
      'select',
      'button-bar',
      'grid',
      'status-bar',
    ]);
  });
});

describe('traits on captured markup', () => {
  it('lookup: label keeps the link and bold markup; code, description and read-only', () => {
    const editor = captured();
    const lookup = ofKind(editor, 'lookup');
    expect(traitNames(lookup)).toEqual(
      expect.arrayContaining(['ec-rotulo', 'ec-valor', 'ec-descricao', 'ec-somente-leitura']),
    );
    expect(trait(lookup, 'ec-rotulo').get()).toBe('Número do Empenho:');
    trait(lookup, 'ec-rotulo').set('Empenho:');
    const out = html(lookup);
    expect(out).toContain('<a href="#" class="lnk"><b>Empenho:</b></a>');
    expect(out).toContain('class="rotulo"');

    trait(lookup, 'ec-valor').set('101/2026');
    trait(lookup, 'ec-descricao').set('Fornecedor Alfa Ltda');
    expect(html(lookup)).toContain('name="e60_numemp" value="101/2026"');
    expect(html(lookup)).toContain(
      'name="descr" value="Fornecedor Alfa Ltda" size="40" readonly="readonly"',
    );
    expect(trait(lookup, 'ec-descricao').get()).toBe('Fornecedor Alfa Ltda');
    // the description input is not the code input
    expect(trait(lookup, 'ec-valor').get()).toBe('101/2026');

    expect(trait(lookup, 'ec-somente-leitura').get()).toBe('0');
    trait(lookup, 'ec-somente-leitura').set('1');
    expect(html(lookup)).toContain(
      'name="e60_numemp" value="101/2026" size="10" readonly="readonly"',
    );
    trait(lookup, 'ec-somente-leitura').set('0');
    expect(html(lookup)).not.toMatch(/name="e60_numemp"[^>]*readonly/);
  });

  it('field on a layout row: label, value, placeholder, no change of the cells and classes', () => {
    const editor = captured();
    const field = ofKind(editor, 'field');
    const before = html(field);
    trait(field, 'ec-rotulo').set('Processo:');
    trait(field, 'ec-valor').set('2026/0042');
    trait(field, 'ec-placeholder').set('nº do processo');
    const after = html(field);
    expect(after).toContain('<b>Processo:</b>');
    expect(after).toContain('value="2026/0042"');
    expect(after).toContain('placeholder="nº do processo"');
    // the same tags and classes: only the label text, the value and the placeholder changed
    const tags = (h: string) => h.replace(/>[^<]*</g, '><').match(/<[a-z]+/g);
    expect(tags(after)).toEqual(tags(before));
    expect(after).toContain('class="rotulo"');
    expect(after).toContain('class="in"');
    expect(field.get('tagName')).toBe('tr');
  });

  it('date-range: both dates and the separator; the calendar buttons are not dates', () => {
    const editor = captured();
    const range = ofKind(editor, 'date-range');
    expect(traitNames(range)).toEqual(
      expect.arrayContaining(['ec-rotulo', 'ec-data-inicial', 'ec-data-final', 'ec-separador']),
    );
    trait(range, 'ec-data-inicial').set('01/01/2026');
    trait(range, 'ec-data-final').set('31/01/2026');
    trait(range, 'ec-separador').set('até');
    const out = html(range);
    expect(out).toContain('name="dt1" value="01/01/2026"');
    expect(out).toContain('name="dt2" value="31/01/2026"');
    expect(out).toContain('<span data-ec-part="separator">até</span>');
    expect(out.match(/value="D"/g)).toHaveLength(2);
    expect(trait(range, 'ec-data-final').get()).toBe('31/01/2026');
  });

  it('select: options are renamed in place, appended as clones and removed', () => {
    const editor = captured();
    const select = ofKind(editor, 'select');
    expect(trait(select, 'ec-opcoes').get()).toBe('Todas\nAtivas');
    trait(select, 'ec-opcoes').set('Todas\nAtivas\nCanceladas');
    const out = html(select);
    expect(out).toContain('<option value="0">Todas</option>');
    expect(out).toContain('<option value="1">Ativas</option>');
    expect(out).toContain('<option>Canceladas</option>'); // new option: no stale value
    trait(select, 'ec-opcoes').set('Todas');
    expect(html(select)).not.toContain('Ativas');
    expect(html(select)).toContain('<select data-ec-part="input" name="sit" class="in">');
  });

  it('button-bar: rename, add (clone of the button keeping the spacing) and remove', () => {
    const editor = captured();
    const bar = ofKind(editor, 'button-bar');
    expect(trait(bar, 'ec-botoes').get()).toBe('Pesquisa\nLimpar campos');
    trait(bar, 'ec-botoes').set('Pesquisar\nLimpar campos\nImprimir');
    const out = html(bar);
    expect(out.match(/<input type="button" data-ec-part="button"/g)).toHaveLength(3);
    expect(out).toContain('value="Pesquisar"');
    expect(out).toContain('value="Imprimir"');
    expect(out).toContain('class="barra"');
    expect(trait(bar, 'ec-botoes').get()).toBe('Pesquisar\nLimpar campos\nImprimir');
    trait(bar, 'ec-botoes').set('Pesquisar');
    expect(html(bar).match(/type="button"/g)).toHaveLength(1);
  });

  it('window title, status bar and fieldset legend', () => {
    const editor = captured();
    const title = ofKind(editor, 'window-title');
    trait(title, 'ec-titulo').set('Consultas > Empenhos');
    expect(html(title)).toContain('<span data-ec-part="title">Consultas &gt; Empenhos</span>');

    const status = ofKind(editor, 'status-bar');
    expect(trait(status, 'ec-textos').get()).toBe(
      'Instituição: Prefeitura de Exemplo\nDepartamento: Finanças',
    );
    trait(status, 'ec-textos').set('Instituição: Prefeitura Modelo\nDepartamento: Compras');
    expect(html(status)).toContain('<span>Instituição: Prefeitura Modelo</span>');
    expect(html(status)).toContain('<span>Departamento: Compras</span>');

    const fieldset = ofKind(editor, 'fieldset');
    trait(fieldset, 'ec-legenda').set('Filtros');
    expect(html(fieldset)).toContain(
      '<legend data-ec-part="legend" class="moldura-legenda">Filtros</legend>',
    );
  });
});

describe('traits on built-in blocks', () => {
  it('field, date and lookup edit label, value, placeholder, read-only and description', () => {
    const field = built('ec-field');
    trait(field, 'ec-rotulo').set('Nome:');
    trait(field, 'ec-valor').set('Ana');
    trait(field, 'ec-somente-leitura').set('1');
    expect(html(field)).toContain('Nome:</label>');
    expect(html(field)).toContain('value="Ana"');
    expect(html(field)).toContain('readonly="readonly"');

    const date = built('ec-date');
    trait(date, 'ec-placeholder').set('dd/mm');
    expect(html(date)).toContain('placeholder="dd/mm"');

    const lookup = built('ec-lookup');
    trait(lookup, 'ec-descricao').set('Credor Teste');
    trait(lookup, 'ec-valor').set('7');
    expect(html(lookup)).toMatch(/data-ec-part="input"[^>]*value="7"/);
    expect(html(lookup)).toMatch(/data-ec-part="desc"[^>]*value="Credor Teste"/);
  });

  it('date-range block: two dates and the separator', () => {
    const range = built('ec-daterange');
    trait(range, 'ec-data-inicial').set('01/02/2026');
    trait(range, 'ec-data-final').set('28/02/2026');
    trait(range, 'ec-separador').set('até');
    expect(html(range)).toContain('value="01/02/2026"');
    expect(html(range)).toContain('value="28/02/2026"');
    expect(html(range)).toContain('>até</span>');
  });

  it('combo, textarea, checkbox, radios, button, button bar', () => {
    const combo = built('ec-combo');
    trait(combo, 'ec-opcoes').set('A\nB');
    expect(trait(combo, 'ec-opcoes').get()).toBe('A\nB');

    const area = built('ec-textarea');
    trait(area, 'ec-texto').set('linha 1\nlinha 2');
    expect(trait(area, 'ec-texto').get()).toBe('linha 1\nlinha 2');

    const check = built('ec-check');
    expect(trait(check, 'ec-rotulo').get()).toBe('Exibir cancelados');
    trait(check, 'ec-marcado').set('1');
    expect(html(check)).toContain('checked="checked"');

    const radios = built('ec-radios');
    expect(trait(radios, 'ec-titulo').get()).toBe('Tipo:');
    expect(trait(radios, 'ec-opcoes').get()).toBe('Analítico\nSintético');
    trait(radios, 'ec-opcoes').set('Analítico\nSintético\nResumido');
    const out = html(radios);
    expect(out.match(/type="radio"/g)).toHaveLength(3);
    expect(out.match(/checked="checked"/g)).toHaveLength(1);
    expect(out).toContain('name="tipo"');
    trait(radios, 'ec-opcoes').set('Só um');
    expect(html(radios).match(/type="radio"/g)).toHaveLength(1);

    const button = built('ec-btn');
    trait(button, 'ec-texto').set('Buscar');
    expect(html(button)).toContain('>Buscar</button>');

    const bar = built('ec-buttons');
    trait(bar, 'ec-botoes').set('Novo\nSalvar');
    expect(html(bar).match(/<button/g)).toHaveLength(2);
    expect(trait(bar, 'ec-botoes').get()).toBe('Novo\nSalvar');
  });

  it('fieldset, tabs, title, status bar and message', () => {
    const fieldset = built('ec-fieldset');
    trait(fieldset, 'ec-legenda').set('Outros dados');
    expect(html(fieldset)).toContain('>Outros dados</legend>');
    expect(fieldset.get('droppable')).not.toBe(false);

    const tabs = built('ec-tabs');
    expect(trait(tabs, 'ec-abas').get()).toBe('Dados\nItens\nHistórico');
    trait(tabs, 'ec-abas').set('Dados\nItens\nAnexos\nNotas');
    expect(html(tabs).match(/data-ec-part="tab"/g)).toHaveLength(4);
    expect(html(tabs).match(/ec-tab-active/g)).toHaveLength(1);
    trait(tabs, 'ec-aba-ativa').set(2);
    expect(trait(tabs, 'ec-aba-ativa').get()).toBe(2);
    trait(tabs, 'ec-abas').set('Só');
    expect(html(tabs)).toContain('ec-tab ec-tab-active');

    const title = built('ec-title');
    trait(title, 'ec-titulo').set('Cadastros');
    expect(html(title)).toContain('>Cadastros</span><span class="ec-title-ctl">');

    const status = built('ec-status');
    trait(status, 'ec-textos').set('Instituição: A\nDepartamento: B');
    expect(trait(status, 'ec-textos').get()).toBe('Instituição: A\nDepartamento: B');

    const msg = built('ec-msg');
    expect(traitNames(msg)).toContain('ec-tipo');
    trait(msg, 'ec-tipo').set('warn');
    trait(msg, 'ec-texto').set('Atenção');
    expect(html(msg)).toContain('ec-msg ec-msg-warn');
    expect(html(msg)).toContain('>Atenção</span>');
  });

  it('a captured message has no "Tipo" (it keeps its own look)', () => {
    const editor = headlessEditor('<div class="aviso" data-ec="message"><b>Aviso:</b> texto</div>');
    const msg = ofKind(editor, 'message');
    expect(traitNames(msg)).not.toContain('ec-tipo');
  });
});

describe('grid editing keeps the styling markup', () => {
  it('reads the columns and rows of a captured grid', () => {
    const grid = ofKind(captured(), 'grid');
    expect(trait(grid, 'ec-colunas').get()).toBe('Empenho\nCredor\nValor');
    expect(trait(grid, 'ec-linhas').get()).toBe(2);
  });

  it('renames columns in place (cells keep their data and classes)', () => {
    const grid = ofKind(captured(), 'grid');
    trait(grid, 'ec-colunas').set('Nº\nFornecedor\nTotal');
    const out = html(grid);
    expect(out).toContain(
      '<tr data-ec-part="header" class="cab"><th>Nº</th><th>Fornecedor</th><th>Total</th></tr>',
    );
    expect(out).toContain('<td class="num">1.250,00</td>');
  });

  it('adds a column by cloning the last header and cell; removes trailing ones', () => {
    const grid = ofKind(captured(), 'grid');
    trait(grid, 'ec-colunas').set('Empenho\nCredor\nValor\nSaldo');
    let out = html(grid);
    expect(out).toContain('<th>Valor</th><th>Saldo</th>');
    // the cloned cell keeps the class of the last one (right-aligned numbers), emptied
    expect(out.match(/<td class="num">/g)).toHaveLength(4);
    expect(out).toContain('<td class="num">\u00a0</td></tr>');
    expect(trait(grid, 'ec-colunas').get()).toBe('Empenho\nCredor\nValor\nSaldo');

    trait(grid, 'ec-colunas').set('Empenho\nCredor');
    out = html(grid);
    expect(out).not.toContain('Valor');
    expect(out).not.toContain('1.250,00');
    expect(out.match(/<td/g)).toHaveLength(4);
  });

  it('adds rows cloning the last data row (keeping the zebra pattern) and removes trailing rows', () => {
    const grid = ofKind(captured(), 'grid');
    trait(grid, 'ec-linhas').set(4);
    const out = html(grid);
    const classes = [...out.matchAll(/<tr data-ec-part="row" class="(linha-[a-z]+)">/g)].map(
      (m) => m[1],
    );
    expect(classes).toEqual(['linha-par', 'linha-impar', 'linha-par', 'linha-impar']);
    expect(out).toContain('<td class="num">\u00a0</td>');
    expect(trait(grid, 'ec-linhas').get()).toBe(4);

    trait(grid, 'ec-linhas').set(1);
    expect(html(grid)).not.toContain('Comércio Beta');
    expect(html(grid)).toContain('Fornecedor Alfa');
  });

  it('works on the built-in grid too', () => {
    const grid = built('ec-grid');
    trait(grid, 'ec-colunas').set('A\nB\nC\nD');
    trait(grid, 'ec-linhas').set(5);
    const out = html(grid);
    expect(out.match(/<th>/g)).toHaveLength(4);
    expect(out.match(/<td>/g)).toHaveLength(20);
    expect(out).toContain('<table data-ec="grid" class="ec-grid">');
  });
});

describe('components behave as units', () => {
  it('locks the parts of a leaf component and leaves containers free', () => {
    const editor = captured();
    const wrapper = editor.getWrapper()!;
    applyUnits(wrapper);
    const lookup = ofKind(editor, 'lookup');
    expect(lookup.get('selectable')).not.toBe(false);
    expect(lookup.get('draggable')).not.toBe(false);
    const parts = all(editor, (c) => c.getAttributes()['data-ec-part'] === 'label');
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part.get('selectable')).toBe(false);
      expect(part.get('hoverable')).toBe(false);
      expect(part.get('draggable')).toBe(false);
    }
    // the inner <b> of the label is locked too
    const bold = all(editor, (c) => c.get('tagName') === 'b')[0]!;
    expect(bold.get('selectable')).toBe(false);
    expect(unitRootOf(bold)).toBe(ofKind(editor, 'lookup'));
    // fieldset: its legend is a part, its layout table and rows stay free
    const fieldset = ofKind(editor, 'fieldset');
    const legend = all(editor, (c) => c.get('tagName') === 'legend')[0]!;
    expect(legend.get('selectable')).toBe(false);
    const layout = all(editor, (c) => c.getClasses().includes('layout'))[0]!;
    expect(layout.get('selectable')).not.toBe(false);
    expect(unitRootOf(layout)).toBe(fieldset);
    // grid cells
    expect(
      all(editor, (c) => c.get('tagName') === 'td' && c.getClasses().includes('num'))[0]!.get(
        'selectable',
      ),
    ).toBe(false);
  });

  it('recognized rows only drop into a table section, cells into a row (also after unlocking)', () => {
    const editor = captured();
    const wrapper = editor.getWrapper()!;
    const SECTIONS = ['tbody', 'thead', 'tfoot'];
    // right at creation (before applyUnits runs) and after it
    expect(ofKind(editor, 'lookup').get('draggable')).toEqual(SECTIONS);
    applyUnits(wrapper);
    for (const kind of ['lookup', 'field', 'date-range', 'select']) {
      expect(ofKind(editor, kind).get('draggable')).toEqual(SECTIONS);
    }
    // entering a part unlocks it with the rule of its tag, not a bare `true`
    const label = all(editor, (c) => c.getAttributes()['data-ec-part'] === 'label')[0]!;
    expect(label.get('draggable')).toBe(false);
    const open = enterPart(label);
    applyUnits(wrapper, open);
    expect(label.get('draggable')).toEqual(['tr']);
    expect(label.get('selectable')).toBe(true);
    applyUnits(wrapper);
    expect(label.get('draggable')).toBe(false);
    // plain divs keep `true`; native table sections keep their own rule
    expect(ofKind(editor, 'fieldset').get('draggable')).toBe(true);
    const tbody = all(editor, (c) => c.get('tagName') === 'tbody')[0]!;
    expect(tbody.get('draggable')).toEqual(['table']);
  });

  it('entering a part unlocks it (and its locked ancestors) until the selection leaves', () => {
    const editor = captured();
    const wrapper = editor.getWrapper()!;
    applyUnits(wrapper);
    const bold = all(editor, (c) => c.get('tagName') === 'b')[0]!;
    const chain = lockedChain(bold);
    expect(chain.map((c) => c.get('tagName'))).toEqual(['b', 'a', 'td']);
    const open = enterPart(bold);
    expect(bold.get('selectable')).toBe(true);
    expect(bold.parent()!.get('selectable')).toBe(true);
    applyUnits(wrapper, open);
    expect(bold.get('selectable')).toBe(true);
    applyUnits(wrapper); // selection left: locked again
    expect(bold.get('selectable')).toBe(false);
  });

  it('names the layers by kind and label', () => {
    const editor = captured();
    applyUnits(editor.getWrapper()!);
    expect(ofKind(editor, 'lookup', 0).getName()).toBe('Lookup: Número do Empenho');
    expect(ofKind(editor, 'lookup', 1).getName()).toBe('Lookup: Credor');
    expect(ofKind(editor, 'grid').getName()).toBe('Grade (3 colunas)');
    expect(ofKind(editor, 'button-bar').getName()).toBe('Barra de botões (2 botões)');
    expect(ofKind(editor, 'fieldset').getName()).toBe('Grupo: Consulta Empenho');
    expect(ofKind(editor, 'date-range').getName()).toBe('Data (intervalo): Período de Emissão');
    expect(ofKind(editor, 'window-title').getName()).toBe(
      'Título de janela: Consultas > Consulta Empenho',
    );
  });

  it('editing a trait renames the layer', () => {
    const editor = captured();
    applyUnits(editor.getWrapper()!);
    const lookup = ofKind(editor, 'lookup');
    trait(lookup, 'ec-rotulo').set('Empenho:');
    expect(lookup.getName()).toBe('Lookup: Empenho');
    const grid = ofKind(editor, 'grid');
    trait(grid, 'ec-colunas').set('A\nB');
    expect(grid.getName()).toBe('Grade (2 colunas)');
  });

  it('locking and naming do not enter the undo history', () => {
    const editor = captured();
    editor.UndoManager.clear();
    applyUnits(editor.getWrapper()!);
    expect(editor.UndoManager.hasUndo()).toBe(false);
  });

  it('duplicating or removing a recognized component moves the whole root', () => {
    const editor = captured();
    applyUnits(editor.getWrapper()!);
    const lookup = ofKind(editor, 'lookup');
    const parent = lookup.parent()!;
    const [copy] = parent.append(lookup.clone(), { at: (lookup.index() ?? 0) + 1 });
    expect(ecKindOf(copy!)).toBe('lookup');
    expect(copy!.get('tagName')).toBe('tr');
    expect(all(editor, (c) => ecKindOf(c) === 'lookup')).toHaveLength(3);
    copy!.remove();
    expect(all(editor, (c) => ecKindOf(c) === 'lookup')).toHaveLength(2);
  });

  it('exports plain HTML: no editor-only attributes leak', () => {
    const editor = captured();
    applyUnits(editor.getWrapper()!);
    const out = editor.getWrapper()!.toHTML();
    expect(out).not.toMatch(/selectable|hoverable|layerable|draggable/);
    expect(out).toContain('data-ec="lookup"');
    expect(out).toContain('data-ec-part="label"');
  });
});
