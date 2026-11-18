import { stepSchema, testDefinitionSchema, type TestLocator } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import {
  describeElement,
  isUnstableId,
  rankLocators,
} from '../../src/contexts/testing/domain/locators';
import type {
  ElementFacts,
  RecorderEvent,
} from '../../src/contexts/testing/domain/recorder-events';
import { newDefinition } from '../../src/contexts/testing/domain/session';
import {
  applyPageAssertion,
  applyRecorderEvent,
  parameterName,
  pruneParameters,
  type RecordingState,
} from '../../src/contexts/testing/domain/step-builder';

function facts(over: Partial<ElementFacts> = {}): ElementFacts {
  return {
    tag: 'input',
    inputType: 'email',
    role: 'textbox',
    name: 'E-mail',
    label: 'E-mail',
    fieldName: 'email',
    candidates: [
      { locator: { kind: 'css', selector: '#email' }, count: 1 },
      { locator: { kind: 'label', text: 'E-mail' }, count: 1 },
      { locator: { kind: 'role', role: 'textbox', name: 'E-mail' }, count: 1 },
    ],
    secret: false,
    bbox: { x: 0.4, y: 0.3, w: 0.2, h: 0.05 },
    frameUrl: null,
    ...over,
  };
}

const button = (name: string) =>
  facts({
    tag: 'button',
    inputType: null,
    role: 'button',
    name,
    label: name,
    fieldName: null,
    candidates: [
      { locator: { kind: 'role', role: 'button', name }, count: 1 },
      { locator: { kind: 'text', text: name }, count: 1 },
    ],
  });

function play(events: RecorderEvent[]): RecordingState {
  let n = 0;
  let state: RecordingState = { definition: newDefinition({}), secrets: {} };
  for (const e of events) {
    state = applyRecorderEvent(
      state,
      e,
      { url: 'https://a.b/login', title: 'Entrar' },
      () => `id${++n}`,
    );
  }
  // whatever comes out is a valid, storable definition
  testDefinitionSchema.parse(state.definition);
  return state;
}

describe('rankLocators', () => {
  it('prefers unique matches by kind priority and drops what matches nothing', () => {
    const ranked = rankLocators([
      { locator: { kind: 'css', selector: '#email' }, count: 1 },
      { locator: { kind: 'text', text: 'E-mail' }, count: 3 },
      { locator: { kind: 'label', text: 'E-mail' }, count: 1 },
      { locator: { kind: 'testid', value: 'login-email' }, count: 1 },
      { locator: { kind: 'placeholder', text: 'x' }, count: 0 },
    ]);
    expect(ranked.map((l) => l.kind)).toEqual(['testid', 'label', 'css', 'text']);
  });

  it('pushes generated ids down and removes duplicates', () => {
    const ranked = rankLocators([
      { locator: { kind: 'css', selector: '#input-3f9a1c2b' }, count: 1 },
      { locator: { kind: 'css', selector: 'form > input:nth-of-type(2)' }, count: 1 },
      { locator: { kind: 'css', selector: 'form > input:nth-of-type(2)' }, count: 1 },
    ]);
    expect(ranked).toEqual<TestLocator[]>([
      { kind: 'css', selector: 'form > input:nth-of-type(2)' },
      { kind: 'css', selector: '#input-3f9a1c2b' },
    ]);
    expect(isUnstableId(':r1a:')).toBe(true);
    expect(isUnstableId('ember123')).toBe(true);
    expect(isUnstableId('email')).toBe(false);
  });

  it('describes elements in pt-BR', () => {
    expect(describeElement(facts())).toBe('campo "E-mail"');
    expect(describeElement(button('Entrar'))).toBe('botão "Entrar"');
    expect(describeElement(facts({ role: null, tag: 'div', label: '', name: '' }))).toBe(
      'elemento',
    );
  });
});

describe('applyRecorderEvent', () => {
  it('turns typing into one fill bound to a parameter with the recorded value', () => {
    const s = play([
      { type: 'fill', facts: facts(), value: 'ana@', at: 1 },
      { type: 'fill', facts: facts(), value: 'ana@exemplo.com', at: 2 },
      { type: 'click', facts: button('Entrar'), at: 3 },
    ]);
    expect(s.definition.steps.map((x) => x.kind)).toEqual(['fill', 'click']);
    const [fill, click] = s.definition.steps;
    expect(fill!.target!.locators[0]).toEqual({ kind: 'role', role: 'textbox', name: 'E-mail' });
    expect(fill!.target!.description).toBe('campo "E-mail"');
    expect(fill!.at).toBe(2);
    expect(s.definition.parameters).toEqual([
      { id: 'id1', name: 'e_mail', label: 'E-mail', type: 'text', secret: false },
    ]);
    expect(fill!.value).toEqual({ param: 'id1' });
    expect(s.definition.dataSets[0]!.values).toEqual({ id1: 'ana@exemplo.com' });
    expect(click!.target!.description).toBe('botão "Entrar"');
  });

  it('keeps secret values out of the definition', () => {
    const pwd = facts({
      inputType: 'password',
      role: null,
      name: 'Senha',
      label: 'Senha',
      fieldName: 'password',
      secret: true,
      candidates: [{ locator: { kind: 'label', text: 'Senha' }, count: 1 }],
    });
    const s = play([{ type: 'fill', facts: pwd, value: 'segredo-123', at: 1 }]);
    expect(JSON.stringify(s.definition)).not.toContain('segredo-123');
    const param = s.definition.parameters[0]!;
    expect(param).toMatchObject({ name: 'senha', type: 'password', secret: true });
    expect(s.definition.dataSets[0]!.values[param.id]).toEqual({ $secret: true });
    expect(s.secrets).toEqual({ recorded: { [param.id]: 'segredo-123' } });
  });

  it('replaces the two clicks of a double click and records selects, checks and keys', () => {
    const cell = button('Linha 1');
    const s = play([
      { type: 'click', facts: cell, at: 1 },
      { type: 'click', facts: cell, at: 2 },
      { type: 'dblclick', facts: cell, at: 3 },
      {
        type: 'select',
        facts: facts({ tag: 'select', role: 'combobox', label: 'UF', name: 'UF', fieldName: 'uf' }),
        value: 'Rio de Janeiro',
        at: 4,
      },
      {
        type: 'check',
        facts: facts({ role: 'checkbox', label: 'Aceito', inputType: 'checkbox' }),
        at: 5,
      },
      { type: 'press', facts: facts(), key: 'Enter', at: 6 },
    ]);
    expect(s.definition.steps.map((x) => x.kind)).toEqual(['dblclick', 'select', 'check', 'press']);
    expect(s.definition.parameters.map((p) => [p.name, p.type])).toEqual([['uf', 'option']]);
    expect(s.definition.steps[3]!.key).toBe('Enter');
  });

  it('records navigations that no action caused, once', () => {
    const s = play([
      { type: 'navigate', url: 'https://a.b/home', at: 1 },
      { type: 'navigate', url: 'https://a.b/home', at: 2 },
    ]);
    expect(s.definition.steps).toHaveLength(1);
    expect(stepSchema.parse(s.definition.steps[0])).toMatchObject({
      kind: 'goto',
      url: 'https://a.b/home',
    });
  });

  it('ignores elements without any usable locator', () => {
    const s = play(
      [{ type: 'click', facts: button('x'), at: 1 }].map((e) => ({
        ...e,
        facts: {
          ...e.facts,
          candidates: [{ locator: { kind: 'text' as const, text: 'x' }, count: 0 }],
        },
      })) as RecorderEvent[],
    );
    expect(s.definition.steps).toEqual([]);
  });

  it('ignores clicks on the page background (html/body)', () => {
    const background = (selector: string) =>
      facts({
        tag: selector,
        inputType: null,
        role: null,
        name: '',
        label: '',
        fieldName: null,
        candidates: [{ locator: { kind: 'css', selector }, count: 1 }],
      });
    const s = play([
      { type: 'click', facts: background('html'), at: 1 },
      { type: 'dblclick', facts: background('body'), at: 2 },
      { type: 'click', facts: button('Entrar'), at: 3 },
    ]);
    expect(s.definition.steps.map((x) => x.kind)).toEqual(['click']);
    expect(s.definition.steps[0]!.target!.description).toBe('botão "Entrar"');
  });
});

describe('parameters', () => {
  it('builds valid unique names from labels', () => {
    expect(parameterName('CPF do Titular', [])).toBe('cpf_do_titular');
    expect(parameterName('Endereço', [])).toBe('endereco');
    expect(parameterName('2ª via', [])).toBe('campo_2_via');
    expect(parameterName('', [])).toBe('campo');
    expect(parameterName('E-mail', ['e_mail', 'e_mail_2'])).toBe('e_mail_3');
  });

  it('prunes parameters (and their secret values) no step uses anymore', () => {
    const pwd = facts({
      secret: true,
      label: 'Senha',
      candidates: [{ locator: { kind: 'label', text: 'Senha' }, count: 1 }],
    });
    const s = play([
      { type: 'fill', facts: facts(), value: 'a', at: 1 },
      { type: 'fill', facts: pwd, value: 'x', at: 2 },
    ]);
    const withoutPwd = {
      ...s,
      definition: { ...s.definition, steps: s.definition.steps.slice(0, 1) },
    };
    const pruned = pruneParameters(withoutPwd);
    expect(pruned.definition.parameters.map((p) => p.name)).toEqual(['e_mail']);
    expect(Object.keys(pruned.definition.dataSets[0]!.values)).toHaveLength(1);
    expect(pruned.secrets).toEqual({ recorded: {} });
  });
});

describe('checks', () => {
  it('page checks take the URL path or the title', () => {
    const page = { url: 'https://a.b/painel?aba=1', title: 'Painel' };
    let s = applyPageAssertion(play([]), 'urlContains', page, () => 'u', 1);
    s = applyPageAssertion(s, 'title', page, () => 't', 2);
    expect(s.definition.steps.map((x) => x.assertion)).toEqual([
      { type: 'urlContains', text: '/painel?aba=1' },
      { type: 'title', text: 'Painel' },
    ]);
    testDefinitionSchema.parse(s.definition);
  });
});
