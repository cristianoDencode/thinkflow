import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../../src/contexts/prototypes/domain/html-sanitizer';
import { SCRUBBED_CELL, scrubHtml } from '../../src/contexts/prototypes/domain/scrub';

const D = SCRUBBED_CELL;

describe('scrubHtml: fields', () => {
  it('clears text-like inputs, keeps button captions, placeholders and toggles', () => {
    const out = scrubHtml(
      '<input type="text" name="nome" value="Ana Souza" placeholder="Nome">' +
        '<input name="cpf" value="123.456.789-00">' +
        '<input type="hidden" name="id" value="42">' +
        '<input type="password" value="x">' +
        '<input type="date" value="2026-01-01">' +
        '<input type="submit" value="Pesquisar">' +
        '<input type="button" value="Limpar">' +
        '<input type="checkbox" value="1" checked>' +
        '<input type="radio" value="a" checked>',
    );
    expect(out).toContain('<input type="text" name="nome" placeholder="Nome">');
    expect(out).toContain('<input name="cpf">');
    expect(out).toContain('<input type="hidden" name="id">');
    expect(out).toContain('<input type="password">');
    expect(out).toContain('<input type="date">');
    expect(out).toContain('<input type="submit" value="Pesquisar">');
    expect(out).toContain('<input type="button" value="Limpar">');
    expect(out).toContain('<input type="checkbox" value="1" checked>');
    expect(out).toContain('<input type="radio" value="a" checked>');
    expect(out).not.toMatch(/Ana Souza|123\.456|2026-01-01/);
  });

  it('empties textareas', () => {
    expect(scrubHtml('<textarea name="obs" rows="3">Paciente com diabetes</textarea>')).toBe(
      '<textarea name="obs" rows="3"></textarea>',
    );
  });

  it('keeps every select option and goes back to the first one', () => {
    const out = scrubHtml(
      '<select name="uf"><option value="RJ">Rio de Janeiro<option value="SP" selected>São Paulo<option value="MG">Minas</select>',
    );
    expect(out).toBe(
      '<select name="uf"><option value="RJ" selected>Rio de Janeiro</option><option value="SP">São Paulo</option><option value="MG">Minas</option></select>',
    );
    // grouped options and a select with nothing selected yet
    const grouped = scrubHtml(
      '<select><optgroup label="G"><option>A</option><option>B</option></optgroup></select>',
    );
    expect(grouped).toContain('<option selected>A</option><option>B</option>');
  });

  it('keeps labels, legends, titles and captions', () => {
    const html =
      '<fieldset><legend>Filtros</legend><label for="a">Código:</label><input id="a" value="9"><button>Pesquisar</button></fieldset><h1>Consulta</h1>';
    const out = scrubHtml(html);
    expect(out).toContain('<legend>Filtros</legend>');
    expect(out).toContain('<label for="a">Código:</label>');
    expect(out).toContain('<button>Pesquisar</button>');
    expect(out).toContain('<h1>Consulta</h1>');
  });
});

describe('scrubHtml: grids', () => {
  it('keeps thead and replaces the body cells with a dash', () => {
    const out = scrubHtml(
      '<table><thead><tr><th>Empenho</th><th>Credor</th></tr></thead>' +
        '<tbody><tr><td>2026/001</td><td><a href="#">Maria da Silva</a></td></tr><tr><td>2026/002</td><td>João</td></tr></tbody></table>',
    );
    expect(out).toContain('<th>Empenho</th><th>Credor</th>');
    expect(out).toBe(
      `<table><thead><tr><th>Empenho</th><th>Credor</th></tr></thead><tbody><tr><td>${D}</td><td>${D}</td></tr><tr><td>${D}</td><td>${D}</td></tr></tbody></table>`,
    );
  });

  it('without thead: th cells or a header-styled first row are kept', () => {
    const withTh = scrubHtml('<table><tr><th>Nome</th></tr><tr><td>Ana</td></tr></table>');
    expect(withTh).toBe(`<table><tr><th>Nome</th></tr><tr><td>${D}</td></tr></table>`);

    const byClass = scrubHtml(
      '<table><tr class="table_header"><td>Nome</td><td>Valor</td></tr><tr><td>Ana</td><td>10,00</td></tr></table>',
    );
    expect(byClass).toContain('<td>Nome</td><td>Valor</td>');
    expect(byClass).not.toMatch(/Ana|10,00/);

    const byBold = scrubHtml('<table><tr><td><b>Nome</b></td></tr><tr><td>Ana</td></tr></table>');
    expect(byBold).toContain('<b>Nome</b>');
    expect(byBold).not.toContain('Ana');

    const byStyle = scrubHtml(
      '<table><tr><td style="font-weight:bold">Nome</td></tr><tr><td>Ana</td></tr></table>',
    );
    expect(byStyle).toContain('>Nome<');
    expect(byStyle).not.toContain('Ana');
  });

  it('leaves layout tables (labels + fields, no header) untouched', () => {
    const html =
      '<table><tr><td>Código:</td><td><input type="text"></td></tr><tr><td>Nome:</td><td>fixo</td></tr></table>';
    expect(scrubHtml(html)).toBe(html);
  });

  it('keeps cells holding fields or nested tables, scrubbing the nested grid on its own', () => {
    const out = scrubHtml(
      '<table><thead><tr><th>Item</th><th>Ação</th></tr></thead><tbody>' +
        '<tr><td>Texto</td><td><input type="checkbox" checked></td></tr>' +
        '<tr><td colspan="2"><table><tr><th>Sub</th></tr><tr><td>Dado</td></tr></table></td></tr></tbody></table>',
    );
    expect(out).toContain(`<td>${D}</td><td><input type="checkbox" checked></td>`);
    expect(out).toContain(`<th>Sub</th></tr><tr><td>${D}</td>`);
    expect(out).not.toMatch(/Texto|Dado/);
  });

  it('keeps empty cells empty, row headers, and handles ARIA grid cells', () => {
    const out = scrubHtml(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tr><th>Linha 1</th><td></td><td>&nbsp;</td><td>x</td></tr></table>' +
        '<div role="grid"><div role="row"><div role="columnheader">Col</div></div><div role="row"><div role="gridcell">valor</div></div></div>',
    );
    expect(out).toContain('<th>Linha 1</th><td></td><td>&nbsp;</td>');
    expect(out).toContain('columnheader">Col<');
    expect(out).toContain(`role="gridcell">${D}<`);
    expect(out).not.toMatch(/>x<|valor/);
  });

  it('composes with the sanitizer (scripts gone, data gone)', () => {
    const out = scrubHtml(
      sanitizeHtml(
        '<input value="Ana"><script>x()</script><table><tr><th>H</th></tr><tr><td>d</td></tr></table>',
      ),
    );
    expect(out).toBe(`<input><table><tr><th>H</th></tr><tr><td>${D}</td></tr></table>`);
  });
});
