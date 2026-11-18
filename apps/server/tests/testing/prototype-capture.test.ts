import type { TestStep } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import {
  absolutizeCssUrls,
  currentStepOf,
  isWindowFrameUrl,
  menuPathBefore,
  pickRoutineChild,
  pickWindowFrame,
  windowIndexInChain,
  type WindowCandidate,
} from '../../src/contexts/testing/domain/prototype-capture';

let n = 0;
const click = (selector: string, text: string, kind: TestStep['kind'] = 'click'): TestStep =>
  ({
    id: `s${++n}`,
    at: n,
    kind,
    target: {
      description: `"${text}"`,
      locators: [
        { kind: 'text', text },
        { kind: 'css', selector },
      ],
      frameUrl: null,
      bbox: null,
      tag: 'a',
      inputType: null,
    },
  }) as unknown as TestStep;
const other = (kind: TestStep['kind']): TestStep => ({ id: `s${++n}`, at: n, kind }) as TestStep;

describe('menu path of a screen', () => {
  const menu = [
    click('#menu', 'MENU'),
    click('#instituicao_1', 'PREFEITURA'),
    click('#area_2', 'DB:FINANCEIRO'),
    click('#modulo_3', 'Empenho'),
    click('#menu_id_4', 'Consultas'),
    click('#menu_id_5', 'Consulta Empenho'),
  ];

  it('is the menu run nearest before the current step', () => {
    const steps = [...menu, other('fill'), other('click')];
    expect(menuPathBefore(steps, steps.at(-1)!.id)).toBe(
      'PREFEITURA > DB:FINANCEIRO > Empenho > Consultas > Consulta Empenho',
    );
  });

  it('is null before any menu navigation or without steps', () => {
    const steps = [other('fill'), ...menu];
    expect(menuPathBefore(steps, steps[0]!.id)).toBeNull();
    expect(menuPathBefore([], null)).toBeNull();
  });

  it('picks the latest run when the session went through the menu twice', () => {
    const second = [
      click('#menu', 'MENU'),
      click('#area_2', 'DB:FINANCEIRO'),
      click('#modulo_3', 'Liquidação'),
      click('#menu_id_9', 'Consultas'),
    ];
    const steps = [...menu, other('fill'), ...second, other('click')];
    const path = menuPathBefore(steps, steps.at(-1)!.id);
    expect(path).toContain('Liquidação');
    // a screen captured between the two runs still gets the first path
    expect(menuPathBefore(steps, steps[6]!.id)).toContain('Consulta Empenho');
  });

  it('the current step is the last one that is not a note or a use-case divider', () => {
    const steps = [other('click'), other('fill'), other('note'), other('usecase')];
    expect(currentStepOf(steps)?.id).toBe(steps[1]!.id);
    expect(currentStepOf([other('note')])).toBeNull();
  });
});

describe('pickRoutineChild', () => {
  const frame = (
    index: number,
    area: number,
    over: Partial<{ visible: boolean; url: string }> = {},
  ) => ({
    index,
    area,
    visible: true,
    url: `https://e/w/${index}/x.php`,
    ...over,
  });

  it('goes down into the biggest visible frame that fills the parent', () => {
    expect(pickRoutineChild(1000, [frame(0, 300), frame(1, 800), frame(2, 500)])?.index).toBe(1);
  });

  it('ignores hidden, blank and tiny frames', () => {
    expect(pickRoutineChild(1000, [frame(0, 900, { visible: false })])).toBeNull();
    expect(pickRoutineChild(1000, [frame(0, 900, { url: 'about:blank' })])).toBeNull();
    expect(pickRoutineChild(1000, [frame(0, 100)])).toBeNull();
    expect(pickRoutineChild(1000, [])).toBeNull();
  });
});

describe('absolutizeCssUrls', () => {
  it('resolves url()s against the stylesheet and leaves data URIs alone', () => {
    const out = absolutizeCssUrls(
      'a{background:url(../img/a.png)}b{background:url("/x.gif")}c{background:url(data:image/png;base64,AA)}d{background:url(#frag)}',
      'https://cdn.exemplo.com/css/site.css',
    );
    expect(out).toContain('url("https://cdn.exemplo.com/img/a.png")');
    expect(out).toContain('url("https://cdn.exemplo.com/x.gif")');
    expect(out).toContain('url(data:image/png;base64,AA)');
    expect(out).toContain('url(#frag)');
  });
});

describe('window frames of the e-Cidade desktop', () => {
  const WIN = 'https://x.y/w/3/extension/desktop/window/index/?action=emp1_empconsulta001.php';
  const frame = (over: Partial<WindowCandidate> = {}): WindowCandidate => ({
    index: 0,
    area: 1_000_000,
    visible: true,
    topmost: true,
    url: WIN,
    ...over,
  });

  it('knows the wrapper by its address, and only the wrapper', () => {
    expect(isWindowFrameUrl(WIN)).toBe(true);
    expect(isWindowFrameUrl('https://x.y/w/3/extension/desktop/window/index')).toBe(true);
    expect(isWindowFrameUrl('https://x.y/w/3/extension/desktop/window/index.php?a=1')).toBe(true);
    expect(isWindowFrameUrl('https://x.y/w/3/extension/desktop/window/bottom')).toBe(false);
    expect(isWindowFrameUrl('https://x.y/extension/desktop')).toBe(false);
    expect(isWindowFrameUrl('https://x.y/w/3/emp1_empconsulta001.php')).toBe(false);
  });

  it('picks the window in front, then the biggest', () => {
    const behind = frame({ index: 0, area: 2_000_000, topmost: false });
    const front = frame({ index: 1, area: 500_000, topmost: true });
    expect(pickWindowFrame([behind, front])?.index).toBe(1);
    const small = frame({ index: 2, area: 100_000 });
    const big = frame({ index: 3, area: 900_000 });
    expect(pickWindowFrame([small, big])?.index).toBe(3);
  });

  it('skips hidden frames and frames that are not windows; null when none', () => {
    expect(pickWindowFrame([])).toBeNull();
    expect(pickWindowFrame([frame({ visible: false })])).toBeNull();
    expect(pickWindowFrame([frame({ url: 'https://x.y/w/3/emp1_x.php' })])).toBeNull();
  });

  it('walks up the chain of frames to the nearest window', () => {
    const routine = 'https://x.y/w/3/emp1_empconsulta001.php';
    const desktop = 'https://x.y/extension/desktop';
    expect(windowIndexInChain([routine, WIN, desktop])).toBe(1);
    expect(windowIndexInChain([WIN, desktop])).toBe(0);
    expect(windowIndexInChain([desktop])).toBe(-1);
    expect(windowIndexInChain([])).toBe(-1);
  });
});
