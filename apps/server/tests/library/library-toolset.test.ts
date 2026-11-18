import { describe, expect, it } from 'vitest';
import { buildLibraryChatTools } from '../../src/contexts/library/application/library-toolset';
import type { LibraryEngine } from '../../src/contexts/library/domain/engine';
import type { Library, LibraryDocument } from '../../src/contexts/library/domain/library';
import { LIBRARY_TOOL_NAME } from '../../src/contexts/library/domain/tool-format';

const library: Library = {
  id: 'l',
  name: 'Regras',
  description: '',
  engine: 'local',
  remoteNotebookId: null,
  createdAt: 1,
  updatedAt: 1,
};
const docs = [{ id: 'd', name: 'regras.md', status: 'ready' } as LibraryDocument];

function engine(textLength: number, seen: { k?: number; maxChars?: number }[] = []): LibraryEngine {
  return {
    kind: 'local',
    search: async (_lib, _q, opts) => {
      seen.push({ k: opts.k, maxChars: opts.maxChars });
      return { text: 'x'.repeat(textLength), isError: false, citations: [] };
    },
  };
}

describe('buildLibraryChatTools', () => {
  it('exposes one tool plus a system note', () => {
    const t = buildLibraryChatTools({
      library,
      documents: docs,
      engine: engine(10),
      maxOutputChars: 6000,
    });
    expect(t.tools.map((x) => x.name)).toEqual([LIBRARY_TOOL_NAME]);
    expect(t.systemNote).toContain('Biblioteca conectada: «Regras»');
  });

  it('validates arguments and unknown tools', async () => {
    const t = buildLibraryChatTools({
      library,
      documents: docs,
      engine: engine(10),
      maxOutputChars: 6000,
    });
    expect((await t.call(LIBRARY_TOOL_NAME, {})).isError).toBe(true);
    expect((await t.call(LIBRARY_TOOL_NAME, { consulta: '   ' })).isError).toBe(true);
    expect((await t.call('outra', { consulta: 'a' })).isError).toBe(true);
  });

  it('clamps k and caps output by the budget', async () => {
    const seen: { k?: number; maxChars?: number }[] = [];
    const t = buildLibraryChatTools({
      library,
      documents: docs,
      engine: engine(9000, seen),
      maxOutputChars: 2000,
    });
    const out = await t.call(LIBRARY_TOOL_NAME, { consulta: 'prazo', max_trechos: 99 });
    expect(seen[0]).toEqual({ k: 8, maxChars: 2000 });
    expect(out.text).toHaveLength(2000);
  });

  it('enforces the per-turn call and character limits', async () => {
    const t = buildLibraryChatTools({
      library,
      documents: docs,
      engine: engine(50),
      maxOutputChars: 6000,
    });
    for (let i = 0; i < 4; i++)
      expect((await t.call(LIBRARY_TOOL_NAME, { consulta: `q${i}` })).text).toHaveLength(50);
    expect((await t.call(LIBRARY_TOOL_NAME, { consulta: 'q5' })).text).toMatch(
      /Limite de consultas/,
    );

    const big = buildLibraryChatTools({
      library,
      documents: docs,
      engine: engine(6000),
      maxOutputChars: 6000,
    });
    await big.call(LIBRARY_TOOL_NAME, { consulta: 'a' });
    await big.call(LIBRARY_TOOL_NAME, { consulta: 'b' });
    expect((await big.call(LIBRARY_TOOL_NAME, { consulta: 'c' })).text).toMatch(
      /Limite de consultas/,
    );
  });

  it('turns engine failures into an error result', async () => {
    const t = buildLibraryChatTools({
      library,
      documents: docs,
      engine: {
        kind: 'local',
        search: async () => {
          throw new Error('db down');
        },
      },
      maxOutputChars: 6000,
    });
    const out = await t.call(LIBRARY_TOOL_NAME, { consulta: 'a' });
    expect(out.isError).toBe(true);
    expect(out.text).not.toContain('db down');
  });
});

describe('buildLibraryChatTools overrides', () => {
  it('uses the given call and character limits instead of the per-turn defaults', async () => {
    const t = buildLibraryChatTools({
      library,
      documents: docs,
      engine: engine(500),
      maxOutputChars: 6000,
      maxCalls: 7,
      maxTotalChars: 40_000,
    });
    for (let i = 0; i < 7; i++) {
      const out = await t.call(LIBRARY_TOOL_NAME, { consulta: `q${i}` });
      expect(out.text).toHaveLength(500);
    }
    const eighth = await t.call(LIBRARY_TOOL_NAME, { consulta: 'q8' });
    expect(eighth.text).not.toHaveLength(500);
  });
});
