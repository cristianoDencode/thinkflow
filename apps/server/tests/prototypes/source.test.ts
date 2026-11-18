import { PROTOTYPE_LIMITS } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import {
  captureName,
  clampSize,
  prepareSnapshot,
  routineFile,
  sourceOf,
  urlWithoutQuery,
} from '../../src/contexts/prototypes/domain/prototype';

describe('source of a captured screen', () => {
  it('takes the routine file from the last path segment ending in .php', () => {
    expect(routineFile('https://e.gov.br/w/3/emp1_empconsulta001.php?x=1&y=2#t')).toBe(
      'emp1_empconsulta001.php',
    );
    expect(routineFile('https://e.gov.br/w/3/EMP1_X.PHP')).toBe('EMP1_X.PHP');
    expect(routineFile('https://e.gov.br/w/3/extension/desktop/window/index/')).toBeNull();
    expect(routineFile('https://e.gov.br/index.html')).toBeNull();
    expect(routineFile('https://e.gov.br/a.php/detalhe')).toBeNull();
    expect(routineFile(null)).toBeNull();
    expect(routineFile('emp1_a.php?x=1')).toBe('emp1_a.php');
  });

  it('drops the query string and hash, and refuses non-http addresses', () => {
    expect(urlWithoutQuery('https://e.gov.br/w/1/a.php?token=segredo&x=1#h')).toBe(
      'https://e.gov.br/w/1/a.php',
    );
    expect(urlWithoutQuery('javascript:alert(1)')).toBeNull();
    expect(urlWithoutQuery('about:blank')).toBeNull();
    expect(urlWithoutQuery('nao é url')).toBeNull();
  });

  it('builds the source and the default name', () => {
    const source = sourceOf({
      url: 'https://e.gov.br/w/1/emp1_empconsulta001.php?id=7',
      title: '  Consulta   Empenho ',
      menuPath: 'DB:FINANCEIRO > Empenho',
    });
    expect(source).toEqual({
      url: 'https://e.gov.br/w/1/emp1_empconsulta001.php',
      file: 'emp1_empconsulta001.php',
      menuPath: 'DB:FINANCEIRO > Empenho',
      title: 'Consulta Empenho',
    });
    const at = new Date(2026, 10, 13, 14, 5).getTime();
    expect(captureName(source, at)).toBe('emp1_empconsulta001.php — 13/11/2026 14:05');
    expect(captureName(sourceOf({ url: null, title: 'Painel', menuPath: null }), at)).toBe(
      'Painel — 13/11/2026 14:05',
    );
    expect(captureName(sourceOf({ url: null, title: null, menuPath: null }), at)).toBe(
      'Tela capturada — 13/11/2026 14:05',
    );
  });
});

describe('prepareSnapshot', () => {
  it('sanitizes, optionally scrubs, and keeps the size inside the limits', () => {
    const snap = prepareSnapshot(
      {
        html: '<body><input value="Ana"><script>x()</script></body>',
        css: '@import "x";a{b:c}',
        width: 50,
        height: 99999,
      },
      { scrub: true },
    );
    expect(snap.html).toBe('<body><input></body>');
    expect(snap.css).toBe('a{b:c}');
    expect(snap.width).toBe(PROTOTYPE_LIMITS.minSize);
    expect(snap.height).toBe(PROTOTYPE_LIMITS.maxHeight);
    expect(clampSize(1300.4, 700.6)).toEqual({ width: 1300, height: 701 });
  });

  it('refuses a snapshot over the size limit with a 413', () => {
    const big = 'a'.repeat(PROTOTYPE_LIMITS.maxSnapshotBytes + 1);
    expect(() =>
      prepareSnapshot({ html: `<body>${big}</body>`, css: '', width: 300, height: 300 }),
    ).toThrow(expect.objectContaining({ httpStatus: 413, code: 'prototype_too_large' }));
  });
});
