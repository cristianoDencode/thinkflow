import { describe, expect, it } from 'vitest';
import { detectMenuPaths, menuLevelOf } from './ct-menu-path';
import { stepSchema, type TestLocator, type TestStep } from './tests';

let n = 0;
function click(locators: TestLocator[], description: string, frameUrl: string | null = null) {
  n += 1;
  return stepSchema.parse({
    id: `s${n}`,
    at: n,
    kind: 'click',
    target: { locators, description, bbox: null, frameUrl },
  });
}
const css = (selector: string): TestLocator => ({ kind: 'css', selector });
const text = (value: string): TestLocator => ({ kind: 'text', text: value });

const menuButton = () =>
  click([{ kind: 'title', text: 'Menu Principal' }, css('#menu')], 'botão "Menu Principal"');
const institution = (label = 'PREFEITURA DE EXEMPLO') =>
  click([text(label), css('#instituicoes > span:nth-of-type(1)')], `texto "${label}"`);
const area = (label = 'DB:FINANCEIRO') =>
  click([text(label), css('#areas > span:nth-of-type(2)')], `texto "${label}"`);
const moduleStep = (label = 'Empenho') =>
  click([text(label), css('#modulos > span:nth-of-type(4)')], `texto "${label}"`);
const item = (label: string, id: number) =>
  click([text(label), css(`#menu_id_${id}`)], `texto "${label}"`);
const other = () => click([{ kind: 'role', role: 'button', name: 'Salvar' }], 'botão "Salvar"');

describe('menuLevelOf', () => {
  it('recognises each level by selector or label', () => {
    expect(menuLevelOf(menuButton())).toBe('button');
    expect(menuLevelOf(institution())).toBe('institution');
    expect(menuLevelOf(area())).toBe('area');
    expect(menuLevelOf(moduleStep())).toBe('module');
    expect(menuLevelOf(item('Consultas', 12))).toBe('item');
    expect(menuLevelOf(click([css('.area_3')], 'texto "X"'))).toBe('area');
    expect(menuLevelOf(click([text('MENU')], 'botão "MENU"'))).toBe('button');
  });

  it('ignores other clicks and anything inside an iframe', () => {
    expect(menuLevelOf(other())).toBeNull();
    expect(
      menuLevelOf(click([css('#menu_id_9')], 'texto "Consultas"', 'https://x/frame')),
    ).toBeNull();
    const fill: TestStep = stepSchema.parse({
      id: 'f',
      at: 1,
      kind: 'fill',
      target: {
        locators: [css('#areas > span')],
        description: 'campo',
        bbox: null,
        frameUrl: null,
      },
      value: { literal: 'a' },
    });
    expect(menuLevelOf(fill)).toBeNull();
  });
});

describe('detectMenuPaths', () => {
  it('suggests the full path on the first step of the run', () => {
    const steps = [
      other(),
      menuButton(),
      area(),
      moduleStep(),
      item('Consultas', 12),
      item('Consulta Empenho', 13),
      other(),
    ];
    const found = detectMenuPaths(steps);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      stepId: steps[1]!.id,
      path: ['DB:FINANCEIRO', 'Empenho', 'Consultas', 'Consulta Empenho'],
      text: 'Após a correção, acessa o menu: DB:FINANCEIRO > Empenho > Consultas > Consulta Empenho',
    });
  });

  it('starts at the institution when it was clicked in the run', () => {
    const steps = [institution('PREFEITURA X'), area(), moduleStep()];
    expect(detectMenuPaths(steps)[0]!.path).toEqual(['PREFEITURA X', 'DB:FINANCEIRO', 'Empenho']);
  });

  it('prepends an institution recorded earlier in the session', () => {
    const steps = [institution('PREFEITURA X'), other(), menuButton(), area(), moduleStep()];
    const found = detectMenuPaths(steps);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toEqual(['PREFEITURA X', 'DB:FINANCEIRO', 'Empenho']);
    expect(found[0]!.stepId).toBe(steps[2]!.id);
  });

  it('starts at the area when no institution was recorded', () => {
    expect(detectMenuPaths([area(), moduleStep()])[0]!.path).toEqual(['DB:FINANCEIRO', 'Empenho']);
  });

  it('finds several runs, a new MENU click starts another', () => {
    const steps = [
      menuButton(),
      area(),
      moduleStep(),
      item('Consultas', 1),
      menuButton(),
      area('DB:PATRIMONIAL'),
      moduleStep('Protocolo'),
    ];
    const found = detectMenuPaths(steps);
    expect(found.map((f) => f.path)).toEqual([
      ['DB:FINANCEIRO', 'Empenho', 'Consultas'],
      ['DB:PATRIMONIAL', 'Protocolo'],
    ]);
  });

  it('ignores lone menu clicks that lead nowhere', () => {
    expect(detectMenuPaths([menuButton(), other()])).toEqual([]);
    expect(detectMenuPaths([area(), other()])).toEqual([]);
    expect(detectMenuPaths([])).toEqual([]);
  });
});
