import { EC_KIND_ATTR, EC_PART_ATTR } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import {
  annotateComponents,
  countComponents,
} from '../../src/contexts/prototypes/domain/components';
import { parseHtml, serializeNodes } from '../../src/contexts/prototypes/domain/html-tree';

/** Annotates `html`; returns the counts and the new markup. */
function run(html: string) {
  const tree = parseHtml(html);
  const counts = annotateComponents(tree);
  return { counts, html: serializeNodes(tree) };
}

/** The `<tag …>` start tags of `html` that carry `data-ec="<kind>"`. */
const tagsOf = (html: string, kind: string): string[] =>
  [...html.matchAll(new RegExp(`<[a-z0-9]+[^>]*${EC_KIND_ATTR}="${kind}"[^>]*>`, 'g'))].map(
    (m) => m[0],
  );

const LOOKUP_LABEL = (text: string) =>
  `<a href="#" class="dbancora" style="color:red;text-decoration:underline"><b>${text}</b></a>`;
const DESC = '<input type="text" readonly style="background-color:#deb887">';

// A routine of the classic e-Cidade layout, with invented data.
const ROUTINE = `<body>
<table class="barra"><tr><td class="janelaTitulo">Consultas &gt; Consulta Empenho</td><td><img src="a.png"><img src="b.png"></td></tr></table>
<form name="form1">
<fieldset><legend><b>Consulta Empenho</b></legend>
<table border="0">
<tr><td nowrap>${LOOKUP_LABEL('Número do Empenho:')}</td><td><input name="e60_codemp" type="text" size="10"> ${DESC}</td></tr>
<tr><td>${LOOKUP_LABEL('Seq. Empenho:')}</td><td><input name="e60_numemp" type="text" size="10"> ${DESC}</td></tr>
<tr><td>${LOOKUP_LABEL('Reduzido:')}</td><td><input name="o58_coddot" type="text" size="10"></td></tr>
<tr><td><b>Data Emissão:</b></td><td><input name="d1" type="text" size="10"><input type="button" value="D"> a <input name="d2" type="text" size="10"><input type="button" value="D"></td></tr>
<tr><td><b>Ordem:</b></td><td><select name="ordem"><option value="1">Número</option><option value="2">Data</option></select></td></tr>
<tr><td><b>Processo Administrativo:</b></td><td><input name="proc" type="text"></td></tr>
</table>
</fieldset>
<center><input type="button" name="pesquisar" value="Pesquisa"> <input type="button" name="limpar" value="Limpar campos"></center>
</form>
<table><tr><td>Instituição: PREFEITURA EXEMPLO</td><td>Departamento: SECRETARIA EXEMPLO</td></tr></table>
</body>`;

describe('component recognition on an e-Cidade routine', () => {
  const { counts, html } = run(ROUTINE);

  it('counts what it found', () => {
    expect(counts).toEqual({
      'window-title': 1,
      fieldset: 1,
      lookup: 3,
      'date-range': 1,
      select: 1,
      field: 1,
      'button-bar': 1,
      'status-bar': 1,
    });
    expect(countComponents(html)).toEqual(counts);
  });

  it('marks the title bar and the status bar', () => {
    const title = tagsOf(html, 'window-title');
    expect(title).toHaveLength(1);
    // the bar: the row that holds the breadcrumb and the icons on the right (a table is layout)
    expect(title[0]).toMatch(/^<tr/);
    // `title` sits on the element that holds the text, inside the bar
    expect(html).toContain(`<td class="janelaTitulo" ${EC_PART_ATTR}="title">`);
    expect(tagsOf(html, 'status-bar')[0]).toMatch(/^<(tr|table)/);
    expect(html).toContain(`<td ${EC_PART_ATTR}="text">Instituição:`);
  });

  it('puts the fieldset on the fieldset and the legend part on its legend', () => {
    expect(tagsOf(html, 'fieldset')[0]).toMatch(/^<fieldset/);
    expect(html).toContain(`<legend ${EC_PART_ATTR}="legend">`);
  });

  it('marks each lookup row on its <tr>, with label / input / desc parts', () => {
    const rows = tagsOf(html, 'lookup');
    expect(rows).toHaveLength(3);
    for (const tag of rows) expect(tag).toMatch(/^<tr/);
    // label = the red anchor, input = the code, desc = the read-only description
    expect(html).toMatch(new RegExp(`<a [^>]*${EC_PART_ATTR}="label"[^>]*><b>Número do Empenho:`));
    const first = html.slice(html.indexOf('Número do Empenho'), html.indexOf('Seq. Empenho'));
    expect(first).toContain(`name="e60_codemp" type="text" size="10" ${EC_PART_ATTR}="input"`);
    expect(first).toContain(`readonly style="background-color:#deb887" ${EC_PART_ATTR}="desc"`);
    // "Reduzido:" has no description
    const third = html.slice(html.indexOf('Reduzido:'), html.indexOf('Data Emissão'));
    expect(third).not.toContain(`${EC_PART_ATTR}="desc"`);
  });

  it('recognizes "input D a input D" as one date range', () => {
    const tags = tagsOf(html, 'date-range');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatch(/^<tr/);
    const row = html.slice(html.indexOf('<tr data-ec="date-range"'), html.indexOf('Ordem:'));
    expect(row.match(new RegExp(`${EC_PART_ATTR}="input"`, 'g'))).toHaveLength(2);
    expect(row.match(new RegExp(`${EC_PART_ATTR}="button"`, 'g'))).toHaveLength(2);
    // the "a" between the dates carries the separator part (a bare span around it)
    expect(row).toContain(`<span ${EC_PART_ATTR}="separator"> a </span>`);
    // the label is the <td> that holds only it
    expect(row).toMatch(new RegExp(`${EC_PART_ATTR}="label"[^>]*><b>Data Emissão:`));
  });

  it('recognizes the select, the plain field and the button bar', () => {
    expect(tagsOf(html, 'select')[0]).toMatch(/^<tr/);
    expect(tagsOf(html, 'field')[0]).toMatch(/^<tr/);
    const bar = tagsOf(html, 'button-bar');
    expect(bar[0]).toMatch(/^<center/);
    expect(html.match(new RegExp(`${EC_PART_ATTR}="button"`, 'g'))!.length).toBe(2 + 2);
  });

  it('only annotates: removing the attributes gives back the markup', () => {
    const stripped = html
      .replace(new RegExp(` ${EC_KIND_ATTR}="[^"]*"`, 'g'), '')
      .replace(new RegExp(` ${EC_PART_ATTR}="[^"]*"`, 'g'), '')
      .replace(/<span> a <\/span>/g, ' a ');
    expect(stripped).toBe(serializeNodes(parseHtml(ROUTINE)));
  });
});

describe('field patterns', () => {
  it('a lone date: input followed by the "D" button', () => {
    const { counts, html } = run(
      '<body><table><tr><td>Data:</td><td><input type="text"><input type="button" value="D"></td></tr></table></body>',
    );
    expect(counts).toEqual({ date: 1 });
    expect(tagsOf(html, 'date')[0]).toMatch(/^<tr/);
  });

  it('three inputs and a "D" button (dd/mm/aaaa) are one date', () => {
    const { counts } = run(
      '<body><table><tr><td>Data:</td><td><input size="2"><input size="2"><input size="4"><input type="button" value="D"></td></tr></table></body>',
    );
    expect(counts).toEqual({ date: 1 });
  });

  it('textarea, checkbox with trailing label, and a radio group', () => {
    const { counts, html } = run(`<body><table>
<tr><td>Obs.:</td><td><textarea></textarea></td></tr>
<tr><td><input type="checkbox" name="a"> Imprimir cabeçalho</td></tr>
<tr><td>Tipo:</td><td><input type="radio" name="t" value="1"> Anulado <input type="radio" name="t" value="2"> Ativo</td></tr>
</table></body>`);
    expect(counts).toEqual({ textarea: 1, checkbox: 1, 'radio-group': 1 });
    expect(tagsOf(html, 'radio-group')[0]).toMatch(/^<tr/);
    expect(html.match(new RegExp(`${EC_PART_ATTR}="input"`, 'g'))).toHaveLength(1 + 1 + 2);
  });

  it('a label beside its control without a table: the container that holds both', () => {
    const { counts, html } = run(
      '<body><div class="linha"><label>Nome:</label> <input type="text"></div><div class="linha"><label>Cidade:</label> <input type="text"></div></body>',
    );
    expect(counts).toEqual({ field: 2 });
    expect(tagsOf(html, 'field').every((t) => t.startsWith('<div'))).toBe(true);
  });

  it('several fields in one row: each control alone, nothing nests', () => {
    const { counts, html } = run(
      '<body><table><tr><td>A:</td><td><input type="text" name="a"></td><td>B:</td><td><select name="b"><option>1</option></select></td></tr></table></body>',
    );
    expect(counts.field).toBe(1);
    expect(counts.select).toBe(1);
    // the <tr> holds two components, so neither can claim it
    expect(tagsOf(html, 'field')[0]).toMatch(/^<input/);
    expect(tagsOf(html, 'select')[0]).toMatch(/^<select/);
  });

  it('a button next to a field is its own component', () => {
    const { counts } = run(
      '<body><table><tr><td><input type="text"> <input type="button" value="Pesquisar"></td></tr></table></body>',
    );
    expect(counts).toEqual({ field: 1, button: 1 });
  });
});

describe('grids, tabs and messages', () => {
  const GRID = `<body><table class="grid">
<tr><th>Empenho</th><th>Credor</th><th>Valor</th></tr>
<tr><td>1</td><td>—</td><td>—</td></tr>
<tr><td>2</td><td>—</td><td>—</td></tr>
</table></body>`;

  it('a table with a header row and data rows is a grid with header / row / cell parts', () => {
    const { counts, html } = run(GRID);
    expect(counts).toEqual({ grid: 1 });
    expect(html.match(new RegExp(`${EC_PART_ATTR}="header"`, 'g'))).toHaveLength(1);
    expect(html.match(new RegExp(`${EC_PART_ATTR}="row"`, 'g'))).toHaveLength(2);
    expect(html.match(new RegExp(`${EC_PART_ATTR}="cell"`, 'g'))).toHaveLength(6);
  });

  it('a header row styled as bold cells counts as the header', () => {
    const { counts } = run(
      '<body><table><tr><td><b>Código</b></td><td><b>Nome</b></td></tr><tr><td>1</td><td>x</td></tr></table></body>',
    );
    expect(counts).toEqual({ grid: 1 });
  });

  it('a form laid out in a table is not a grid, and the fields of a grid are not read as fields', () => {
    const form = run(
      '<body><table><tr><td><b>Nome:</b></td><td><b>Idade:</b></td></tr><tr><td><input type="text"></td><td><input type="text"></td></tr></table></body>',
    );
    expect(form.counts.grid).toBeUndefined();
    const grid = run(
      '<body><table><tr><th>Sel</th><th>Nome</th></tr><tr><td>x</td><td>y <input type="text"></td></tr></table></body>',
    );
    expect(grid.counts).toEqual({ grid: 1 });
  });

  it('tab bar and panels under one parent', () => {
    const { counts, html } = run(`<body><div class="abas-wrap">
<ul class="abas"><li class="aba">Geral</li><li class="aba">Itens</li></ul>
<div class="painel">conteúdo 1</div><div class="painel">conteúdo 2</div></div></body>`);
    expect(counts).toEqual({ tabs: 1 });
    expect(tagsOf(html, 'tabs')[0]).toContain('class="abas-wrap"');
    expect(html.match(new RegExp(`${EC_PART_ATTR}="tab"`, 'g'))).toHaveLength(2);
    expect(html.match(new RegExp(`${EC_PART_ATTR}="panel"`, 'g'))).toHaveLength(2);
  });

  it('message boxes', () => {
    const { counts, html } = run(
      '<body><div class="alert alert-warning"><strong>Atenção</strong> Nenhum registro encontrado.</div><p class="texto">livre</p></body>',
    );
    expect(counts).toEqual({ message: 1 });
    expect(html).toContain(`<strong ${EC_PART_ATTR}="title">`);
    // the loose text gets a bare span with the `text` part
    expect(html).toContain(`<span ${EC_PART_ATTR}="text"> Nenhum registro encontrado.</span>`);
  });

  it('plain text, breadcrumbs without ">" and fields labelled "Instituição:" are left alone', () => {
    const { counts } = run(
      '<body><p>Resumo do empenho</p><table><tr><td>Instituição:</td><td><input type="text"></td></tr></table></body>',
    );
    expect(counts).toEqual({ field: 1 });
  });
});

describe('robustness', () => {
  it('empty and tag-only documents', () => {
    expect(run('').counts).toEqual({});
    expect(run('<body></body>').counts).toEqual({});
  });

  it('never marks an element twice, and a rerun adds nothing', () => {
    const once = run(ROUTINE).html;
    const again = run(once);
    expect(again.html).toBe(once);
  });

  it('a flattened frame is never itself a title or a status bar, its content may be', () => {
    const { counts, html } = run(
      '<body><div data-tf-frame="1" style="width:300px"><p>Consultas &gt; Consulta Empenho</p></div></body>',
    );
    expect(counts).toEqual({ 'window-title': 1 });
    expect(tagsOf(html, 'window-title')[0]).toMatch(/^<p/);
  });
});
