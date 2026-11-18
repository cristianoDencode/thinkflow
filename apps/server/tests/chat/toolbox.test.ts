import { describe, expect, it } from 'vitest';
import { combineToolsets } from '../../src/contexts/chat/application/toolbox';

const mcp = {
  tools: [
    { alias: 'mcp__docs__lookup', description: 'x'.repeat(2000), inputSchema: { type: 'object' } },
  ],
  call: async (alias: string) => ({ text: `mcp:${alias}`, isError: false }),
};
const lib = {
  tools: [{ name: 'buscar_na_biblioteca', description: 'Busca', parameters: { type: 'object' } }],
  call: async (name: string) => ({ text: `lib:${name}`, isError: false }),
};

describe('combineToolsets', () => {
  it('returns null when there is nothing to call', () => {
    expect(combineToolsets(null, null)).toBeNull();
    expect(combineToolsets({ ...mcp, tools: [] }, null)).toBeNull();
  });

  it('exposes MCP only, library only and both', () => {
    expect(combineToolsets(mcp, null)!.defs.map((d) => d.function.name)).toEqual([
      'mcp__docs__lookup',
    ]);
    expect(combineToolsets(null, lib)!.defs.map((d) => d.function.name)).toEqual([
      'buscar_na_biblioteca',
    ]);
    const both = combineToolsets(mcp, lib)!;
    expect(both.defs.map((d) => d.function.name).sort()).toEqual([
      'buscar_na_biblioteca',
      'mcp__docs__lookup',
    ]);
    expect(both.defs.every((d) => d.type === 'function')).toBe(true);
    expect(
      both.defs.find((d) => d.function.name === 'mcp__docs__lookup')!.function.description,
    ).toHaveLength(1000);
  });

  it('routes calls by name and reports unknown tools', async () => {
    const both = combineToolsets(mcp, lib)!;
    expect((await both.call('buscar_na_biblioteca', {})).text).toBe('lib:buscar_na_biblioteca');
    expect((await both.call('mcp__docs__lookup', {})).text).toBe('mcp:mcp__docs__lookup');
    const unknown = await both.call('nada', {});
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('nada');
    // library-only box must not leak calls to a missing MCP set
    expect((await combineToolsets(null, lib)!.call('mcp__docs__lookup', {})).isError).toBe(true);
  });

  it('accepts any number of extra tool sets, the first owner of a name wins', async () => {
    const preset = {
      tools: [{ name: 'gerar_documento', description: 'Gera', parameters: { type: 'object' } }],
      call: async (name: string) => ({ text: `preset:${name}`, isError: false }),
    };
    const shadow = {
      tools: [{ name: 'gerar_documento', description: 'Outra', parameters: { type: 'object' } }],
      call: async () => ({ text: 'shadow', isError: false }),
    };
    const box = combineToolsets(mcp, lib, preset, null, shadow)!;
    expect(box.defs.map((d) => d.function.name)).toEqual([
      'buscar_na_biblioteca',
      'gerar_documento',
      'mcp__docs__lookup',
    ]);
    expect((await box.call('gerar_documento', {})).text).toBe('preset:gerar_documento');
    expect((await box.call('buscar_na_biblioteca', {})).text).toBe('lib:buscar_na_biblioteca');
    expect((await box.call('mcp__docs__lookup', {})).text).toBe('mcp:mcp__docs__lookup');
    // the preset tool alone works without MCP or library
    expect(combineToolsets(null, null, preset)!.defs).toHaveLength(1);
  });
});
