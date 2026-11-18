import type { TestDefinition } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import { resolveValues, updateData } from '../../src/contexts/testing/domain/data';
import { newDefinition } from '../../src/contexts/testing/domain/session';
import type { RecordingState } from '../../src/contexts/testing/domain/step-builder';

function state(): RecordingState {
  const def: TestDefinition = {
    ...newDefinition({}),
    parameters: [
      { id: 'p1', name: 'email', label: 'E-mail', type: 'text', secret: false },
      { id: 'p2', name: 'senha', label: 'Senha', type: 'password', secret: true },
    ],
    dataSets: [
      { id: 'recorded', name: 'Gravado', values: { p1: 'ana@x.com', p2: { $secret: true } } },
    ],
  };
  return { definition: def, secrets: { recorded: { p2: 'segredo' } } };
}

describe('updateData', () => {
  it('adds data sets, keeps secrets behind the marker and stores new ones apart', () => {
    const s = state();
    const next = updateData(s, {
      parameters: s.definition.parameters,
      dataSets: [
        s.definition.dataSets[0]!,
        { id: 'd2', name: ' E-mail inválido ', values: { p1: 'ana@', p2: 'outra-senha' } },
        { id: 'd3', name: 'Só e-mail', values: { p1: 'bia@x.com' } },
      ],
    });
    expect(next.definition.dataSets.map((d) => d.name)).toEqual([
      'Gravado',
      'E-mail inválido',
      'Só e-mail',
    ]);
    expect(JSON.stringify(next.definition)).not.toContain('outra-senha');
    expect(next.definition.dataSets[1]!.values).toEqual({ p1: 'ana@', p2: { $secret: true } });
    expect(next.secrets).toEqual({ recorded: { p2: 'segredo' }, d2: { p2: 'outra-senha' } });

    // missing values fall back to the recorded set
    expect(resolveValues(next.definition, next.secrets, 'd3')).toEqual({
      p1: 'bia@x.com',
      p2: 'segredo',
    });
    expect(resolveValues(next.definition, next.secrets, 'd2')).toEqual({
      p1: 'ana@',
      p2: 'outra-senha',
    });
    expect(resolveValues(next.definition, next.secrets, null)).toEqual({
      p1: 'ana@x.com',
      p2: 'segredo',
    });
  });

  it('moves values in and out of the vault when a parameter changes secrecy', () => {
    const s = state();
    const toggled = updateData(s, {
      parameters: [
        { ...s.definition.parameters[0]!, secret: true },
        { ...s.definition.parameters[1]!, secret: false },
      ],
      dataSets: s.definition.dataSets,
    });
    expect(toggled.definition.dataSets[0]!.values).toEqual({
      p1: { $secret: true },
      p2: 'segredo',
    });
    expect(toggled.secrets).toEqual({ recorded: { p1: 'ana@x.com' } });
  });

  it('refuses to add or remove parameters, duplicated names, or moving the recorded set', () => {
    const s = state();
    const p = s.definition.parameters;
    expect(() => updateData(s, { parameters: [p[0]!], dataSets: s.definition.dataSets })).toThrow(
      'sem incluir nem remover',
    );
    expect(() =>
      updateData(s, {
        parameters: [p[0]!, { ...p[1]!, name: 'email' }],
        dataSets: s.definition.dataSets,
      }),
    ).toThrow('repetido');
    expect(() =>
      updateData(s, { parameters: p, dataSets: [{ id: 'x', name: 'x', values: {} }] }),
    ).toThrow('Gravado');
  });
});
