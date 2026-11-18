import { describe, expect, it } from 'vitest';
import { parseHtml, serializeNodes } from '../../src/contexts/prototypes/domain/html-tree';
import {
  placeholderFor,
  replacePii,
  scrubPersonalData,
} from '../../src/contexts/prototypes/domain/pii-scrub';
import { scrubHtml } from '../../src/contexts/prototypes/domain/scrub';

// Invented data only (the CPF and the CNPJ are the well-known fake ones with valid check digits).
const CPF = '529.982.247-25';
const CPF_BARE = '52998224725';
const CNPJ = '11.222.333/0001-81';

function scrub(html: string): { html: string; replaced: number } {
  const tree = parseHtml(html);
  const replaced = scrubPersonalData(tree);
  return { html: serializeNodes(tree), replaced };
}

describe('placeholders', () => {
  it('keep the shape of what they replace', () => {
    expect(placeholderFor('CPF', CPF)).toBe('000.000.000-00');
    expect(placeholderFor('CPF', CPF_BARE)).toBe('00000000000');
    expect(placeholderFor('CNPJ', CNPJ)).toBe('00.000.000/0000-00');
    expect(placeholderFor('TELEFONE', '(21) 98765-4321')).toBe('(00) 00000-0000');
    expect(placeholderFor('CEP', '20040-020')).toBe('00000-000');
    expect(placeholderFor('PLACA', 'ABC1D23')).toBe('AAA0A00');
    expect(placeholderFor('EMAIL', 'maria@prefeitura.gov.br')).toBe('usuario@exemplo.com');
    expect(placeholderFor('NOME', 'Maria da Silva')).toBe('Nome Exemplo');
    expect(placeholderFor('NOME', 'MARIA DA SILVA')).toBe('NOME EXEMPLO');
  });
});

describe('replacePii', () => {
  it('replaces what the detectors find and keeps the rest of the text', () => {
    expect(replacePii(`CPF: ${CPF} — cadastrado`)).toBe('CPF: 000.000.000-00 — cadastrado');
    expect(replacePii(`Usuário ${CPF_BARE} logado`)).toBe('Usuário 00000000000 logado');
    expect(replacePii(`Credor ${CNPJ}`)).toBe('Credor 00.000.000/0000-00');
    expect(replacePii('Contato: maria.souza@exemplo.org')).toBe('Contato: usuario@exemplo.com');
    expect(replacePii('Responsável: João Pereira Souza')).toBe('Responsável: Nome Exemplo');
  });

  it('leaves ordinary screen text alone', () => {
    for (const text of [
      'Consultas > Consulta Empenho',
      'Número do Empenho:',
      'Instituição: PREFEITURA MUNICIPAL EXEMPLO Departamento: SECRETARIA DE FINANÇAS',
      'Pesquisa',
      '2026/0001',
      'ab',
    ]) {
      expect(replacePii(text), text).toBeNull();
    }
  });
});

describe('scrubPersonalData on a tree', () => {
  it('replaces the user bar of the desktop, text and attributes alike', () => {
    const { html, replaced } = scrub(
      `<body><div class="usuario" title="Usuário ${CPF_BARE}">${CPF_BARE} — Maria da Silva</div>` +
        `<img alt="Foto de João Pereira Souza" src="x.png"><a href="/perfil?cpf=${CPF_BARE}">perfil</a>` +
        '<p>texto &amp; mais texto</p></body>',
    );
    expect(replaced).toBe(4);
    expect(html).not.toContain(CPF_BARE);
    expect(html).not.toContain('Maria');
    expect(html).not.toContain('Pereira');
    expect(html).toContain(
      '<div class="usuario" title="Usuário 00000000000">00000000000 — Nome Exemplo</div>',
    );
    expect(html).toContain('alt="Foto de Nome Exemplo"');
    expect(html).toContain('href="/perfil?cpf=00000000000"');
    // untouched text keeps its entities
    expect(html).toContain('<p>texto &amp; mais texto</p>');
  });

  it('escapes what it writes and never touches scripts, styles or data URIs', () => {
    const { html } = scrub(
      `<body><p>a &lt; b — ${CPF}</p><style>.x{content:"${CPF}"}</style><img src="data:image/png;base64,${CPF_BARE}AAAA" title="${CPF}"></body>`,
    );
    expect(html).toContain('<p>a &lt; b — 000.000.000-00</p>');
    expect(html).toContain(`.x{content:"${CPF}"}`);
    expect(html).toContain(`src="data:image/png;base64,${CPF_BARE}AAAA"`);
    expect(html).toContain('title="000.000.000-00"');
  });

  it("is part of the scrub of a captured screen (but not of the user's own markup edits)", () => {
    const out = scrubHtml(
      `<body><div>${CPF_BARE}</div><input value="Ana"><table><tr><th>Credor</th></tr><tr><td>${CNPJ}</td></tr></table></body>`,
    );
    expect(out).not.toContain(CPF_BARE);
    expect(out).toContain('<div>00000000000</div>');
    expect(out).not.toContain('value="Ana"');
    expect(out).not.toContain('11.222');
  });
});
