import type { PrototypeScene } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import {
  blockDocument,
  markSceneLayers,
  pngDimensions,
  sceneAssetIds,
  sceneToHtml,
} from '../../src/contexts/prototypes/domain/scene';
import { fakePng } from './fake-renderer';

const LOOKUP = (label: string, extra = '') =>
  `<tr data-ec="lookup"${extra}><td data-ec-part="label"><a>${label}:</a></td><td><input data-ec-part="input"></td></tr>`;

describe('markSceneLayers', () => {
  it('marks the outermost leaf components, in document order, and names them', () => {
    const html = `<body><div data-ec="window-title"><span data-ec-part="title">Consulta Empenho</span></div>
      <table>${LOOKUP('Reduzido')}
      <tr data-ec="date-range"><td data-ec-part="label">Data Emissão&nbsp;:</td><td>x</td></tr></table>
      <div data-ec="button-bar"><input type="button" data-ec-part="button" value="Pesquisa"></div>
      <div data-ec="status-bar">Instituição: X</div></body>`;
    const { html: marked, layers } = markSceneLayers(html);
    expect(layers).toEqual([
      { n: 1, kind: 'window-title', name: 'Título de janela: Consulta Empenho' },
      { n: 2, kind: 'lookup', name: 'Lookup: Reduzido' },
      { n: 3, kind: 'date-range', name: 'Data (intervalo): Data Emissão' },
      { n: 4, kind: 'button-bar', name: 'Barra de botões' },
      { n: 5, kind: 'status-bar', name: 'Barra de status' },
    ]);
    expect(marked).toContain('<tr data-ec="lookup" data-tf-layer="2">');
    expect(marked).toContain('data-ec="status-bar" data-tf-layer="5"');
  });

  it('makes fieldsets and tabs container layers listed before their children', () => {
    const html = `<body><fieldset data-ec="fieldset"><legend data-ec-part="legend">Filtros</legend>
      <table>${LOOKUP('Credor')}</table>
      <div data-ec="tabs"><div data-ec-part="tab">A</div><div data-ec-part="panel"><div data-ec="field"><span data-ec-part="label">Nome:</span><input></div></div></div>
      </fieldset></body>`;
    const { html: marked, layers } = markSceneLayers(html);
    expect(layers.map((l) => [l.n, l.kind, l.name])).toEqual([
      [1, 'fieldset', 'Grupo: Filtros'],
      [2, 'lookup', 'Lookup: Credor'],
      [3, 'tabs', 'Abas'],
      [4, 'field', 'Campo: Nome'],
    ]);
    expect(marked).toContain(
      '<fieldset data-ec="fieldset" data-tf-layer="1" data-tf-container="0">',
    );
    expect(marked).toContain('data-ec="tabs" data-tf-layer="3" data-tf-container="1"');
    expect(marked).not.toMatch(/data-ec="lookup"[^>]*data-tf-container/);
  });

  it('does not count a container nested inside a leaf', () => {
    const html = `<body><div data-ec="grid"><fieldset data-ec="fieldset"><legend data-ec-part="legend">x</legend></fieldset></div></body>`;
    const { html: marked, layers } = markSceneLayers(html);
    expect(layers).toEqual([{ n: 1, kind: 'grid', name: 'Grade' }]);
    expect(marked).not.toContain('data-tf-container');
  });

  it('turns loose buttons and controls into layers, but not hidden inputs, images or parts of a component', () => {
    const html = `<body><fieldset data-ec="fieldset"><legend data-ec-part="legend">Consulta Empenho</legend>
      <input name="limpa" type="button" value="Limpar campos">
      <input type="hidden" name="h" value="1">
      <input name="q"><select name="s"><option>a</option></select><textarea name="t"></textarea>
      <img src="data:image/png;base64,AAAA" alt="">
      <button type="submit">Enviar <b>agora</b></button>
      <div data-ec="button-bar"><input type="button" value="Pesquisa"><button>Dentro</button></div>
      </fieldset></body>`;
    const { html: marked, layers } = markSceneLayers(html);
    expect(layers.map((l) => [l.n, l.kind, l.name])).toEqual([
      [1, 'fieldset', 'Grupo: Consulta Empenho'],
      [2, 'button', 'Botão: Limpar campos'],
      [3, 'field', 'Campo'],
      [4, 'select', 'Lista'],
      [5, 'textarea', 'Área de texto'],
      [6, 'button', 'Botão: Enviar agora'],
      [7, 'button-bar', 'Barra de botões'],
    ]);
    expect(marked).toContain(
      '<input name="limpa" type="button" value="Limpar campos" data-tf-layer="2">',
    );
    expect(marked).not.toMatch(/type="hidden"[^>]*data-tf-layer/);
    expect(marked).not.toMatch(/<img[^>]*data-tf-layer/);
    expect(marked.match(/data-tf-layer/g)).toHaveLength(7);
  });

  it('does not count a component nested inside another leaf, and drops stale marks', () => {
    const html = `<body><div data-ec="grid" data-tf-layer="9"><div data-ec="button" data-tf-layer="3">x</div></div></body>`;
    const { html: marked, layers } = markSceneLayers(html);
    expect(layers).toEqual([{ n: 1, kind: 'grid', name: 'Grade' }]);
    expect(marked.match(/data-tf-layer/g)).toHaveLength(1);
    expect(marked).toContain('data-tf-layer="1"');
  });

  it('ignores unknown kinds and names buttons by their value or text', () => {
    const html = `<body><div data-ec="bogus"><input data-ec="button" value="Salvar &amp; fechar"></div><div data-ec="message"><span data-ec-part="text">Registro salvo.</span></div></body>`;
    const { layers } = markSceneLayers(html);
    expect(layers).toEqual([
      { n: 1, kind: 'button', name: 'Botão: Salvar & fechar' },
      { n: 2, kind: 'message', name: 'Mensagem: Registro salvo.' },
    ]);
  });

  it('returns no layers for plain HTML', () => {
    expect(markSceneLayers('<body><p>oi</p></body>')).toEqual({
      html: '<body><p>oi</p></body>',
      layers: [],
    });
  });

  it('caps the layers at the scene limit', () => {
    const html = `<body>${'<div data-ec="button">x</div>'.repeat(520)}</body>`;
    const { html: marked, layers } = markSceneLayers(html);
    expect(layers).toHaveLength(500);
    expect(marked.match(/data-tf-layer/g)).toHaveLength(500);
  });
});

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

const scene = (
  layers: PrototypeScene['layers'],
  background: string | null = A,
): PrototypeScene => ({
  version: 1,
  background: background ? { asset: background } : null,
  layers,
});

const base = { x: 5, y: 6, width: 70, height: 20, visible: true, locked: false } as const;

describe('sceneToHtml', () => {
  const assets = new Map([
    [A, 'data:image/png;base64,AAAA'],
    [B, 'data:image/png;base64,BBBB'],
  ]);
  const size = { width: 800, height: 600 };

  it('draws the background, then the visible layers in order, absolutely positioned', () => {
    const html = sceneToHtml(
      scene([
        { ...base, id: '1', name: 'img', type: 'image', image: { asset: B } },
        { ...base, id: '2', name: 'oculta', type: 'rect', visible: false, rect: { fill: 'red' } },
        {
          ...base,
          id: '3',
          name: 'rect',
          type: 'rect',
          rect: { fill: '#fff', stroke: '#000', strokeWidth: 2, radius: 4 },
        },
      ]),
      size,
      assets,
    );
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain(
      '<body style="margin:0;width:800px;height:600px;position:relative;overflow:hidden;background:#fff">',
    );
    const bg = html.indexOf('base64,AAAA');
    const img = html.indexOf('base64,BBBB');
    const rect = html.indexOf('border:2px solid #000');
    expect(bg).toBeGreaterThan(0);
    expect(img).toBeGreaterThan(bg);
    expect(rect).toBeGreaterThan(img);
    expect(html).toContain('left:5px;top:6px;width:70px;height:20px');
    expect(html).toContain('border-radius:4px');
    expect(html).not.toContain('red'); // the hidden layer is omitted
    expect(html).toContain('position:absolute;left:0;top:0;width:800px;height:600px');
  });

  it('escapes text and keeps only safe style values', () => {
    const html = sceneToHtml(
      scene(
        [
          {
            ...base,
            id: '1',
            name: 't',
            type: 'text',
            text: {
              value: '<b onclick="x">Olá & "tchau"</b>\nlinha 2',
              fontSize: 12,
              fontFamily: 'Arial;}</style><script>x</script>',
              color: 'red;background:url(http://x)',
              bold: true,
              align: 'center',
            },
          },
        ],
        null,
      ),
      size,
      assets,
    );
    expect(html).toContain(
      '&lt;b onclick=&quot;x&quot;&gt;Olá &amp; &quot;tchau&quot;&lt;/b&gt;\nlinha 2',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('url(');
    expect(html).toContain('font-weight:bold');
    expect(html).toContain('text-align:center');
    expect(html).toContain('white-space:pre-wrap');
    expect(html).toContain('color:#000000');
    expect(html).toContain('font-family:Arial, Helvetica, sans-serif');
    expect(html).not.toContain('<img'); // no background
  });

  it('leaves out an image whose asset is not available', () => {
    const html = sceneToHtml(
      scene([{ ...base, id: '1', name: 'i', type: 'image', image: { asset: B } }], null),
      size,
      new Map(),
    );
    expect(html).not.toContain('<img');
  });
});

describe('sceneAssetIds / blockDocument / pngDimensions', () => {
  it('lists each asset once, background first', () => {
    const s = scene([
      { ...base, id: '1', name: 'i', type: 'image', image: { asset: B } },
      { ...base, id: '2', name: 'j', type: 'image', image: { asset: B } },
      { ...base, id: '3', name: 'k', type: 'image', image: { asset: A } },
    ]);
    expect(sceneAssetIds(s)).toEqual([A, B]);
  });

  it('wraps a block in the e-Cidade window background', () => {
    const doc = blockDocument('<p>x</p>', 'p{color:red}');
    expect(doc).toContain(
      '<div data-tf-block style="display:inline-block;padding:2px"><p>x</p></div>',
    );
    expect(doc).toContain(
      'body{margin:0;background:#e0e0e0;font:11px Arial,Helvetica,sans-serif}p{color:red}',
    );
  });

  it('reads PNG sizes', () => {
    expect(pngDimensions(fakePng(30, 40))).toEqual({ width: 30, height: 40 });
    expect(pngDimensions(new Uint8Array(40))).toBeNull();
  });
});
