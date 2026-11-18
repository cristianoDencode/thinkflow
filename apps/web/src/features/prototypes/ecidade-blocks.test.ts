import { describe, expect, it } from 'vitest';
import { ECIDADE_COMPONENT_KINDS, ECIDADE_COMPONENT_PARTS } from '@thinkflow/shared';
import {
  BASIC_BLOCKS,
  blockContent,
  ECIDADE_BLOCKS,
  ECIDADE_CATEGORY,
  ECIDADE_CSS,
} from './ecidade-blocks';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html').body;

describe('e-Cidade blocks', () => {
  it('has the requested set of components', () => {
    const ids = ECIDADE_BLOCKS.map((b) => b.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'ec-field',
        'ec-combo',
        'ec-lookup',
        'ec-date',
        'ec-textarea',
        'ec-check',
        'ec-radios',
        'ec-btn',
        'ec-buttons',
        'ec-fieldset',
        'ec-grid',
        'ec-tabs',
        'ec-title',
        'ec-status',
        'ec-daterange',
        'ec-msg',
      ]),
    );
    expect(new Set([...ids, ...BASIC_BLOCKS.map((b) => b.id)]).size).toBe(
      ids.length + BASIC_BLOCKS.length,
    );
  });

  it.each(ECIDADE_BLOCKS)('$id is one valid element with an ec-* class and no scripts', (block) => {
    expect(block.category).toBe(ECIDADE_CATEGORY);
    const body = parse(block.html);
    expect(body.children).toHaveLength(1);
    const root = body.firstElementChild!;
    expect([...root.classList].some((c) => c.startsWith('ec-'))).toBe(true);
    expect(body.querySelector('script, iframe, object, embed, link')).toBeNull();
    // no inline handlers / styles: styling lives in the shared css
    for (const el of [root, ...root.querySelectorAll('*')]) {
      expect(el.getAttributeNames().filter((a) => a.startsWith('on') || a === 'style')).toEqual([]);
    }
    expect(block.label.length).toBeGreaterThan(0);
  });

  it('covers every kind of the capture contract', () => {
    const kinds = ECIDADE_BLOCKS.map((b) =>
      parse(b.html).firstElementChild!.getAttribute('data-ec'),
    );
    expect(new Set(kinds)).toEqual(new Set(ECIDADE_COMPONENT_KINDS));
  });

  it.each(ECIDADE_BLOCKS)(
    '$id root has data-ec and every data-ec-part is a contract part',
    (block) => {
      const root = parse(block.html).firstElementChild!;
      expect(ECIDADE_COMPONENT_KINDS).toContain(root.getAttribute('data-ec'));
      for (const el of root.querySelectorAll('[data-ec-part]')) {
        expect(ECIDADE_COMPONENT_PARTS).toContain(el.getAttribute('data-ec-part'));
      }
      for (const el of root.querySelectorAll('[data-ec]')) {
        expect(ECIDADE_COMPONENT_KINDS).toContain(el.getAttribute('data-ec'));
      }
    },
  );

  it.each(ECIDADE_BLOCKS)('$id css defines every ec-* class its html uses', (block) => {
    const used = new Set(block.html.match(/ec-[a-z-]+/g));
    for (const cls of used) {
      // a modifier (ec-msg-info, ec-tab-active) only needs its base rule family to exist
      expect(
        block.css.includes(`.${cls}`) || block.css.includes(`.${cls.replace(/-[a-z]+$/, '')}`),
      ).toBe(true);
    }
  });

  it('blocks hug their content (selection border fits) except the full-width window chrome', () => {
    const rule = (cls: string) =>
      ECIDADE_CSS.split('\n').find(
        (l) => l.split('{')[0]!.split(',').includes(`.${cls}`) && /width:/.test(l),
      );
    for (const cls of [
      'ec-field',
      'ec-combo',
      'ec-lookup',
      'ec-date',
      'ec-daterange',
      'ec-textarea',
      'ec-check',
      'ec-radios',
      'ec-buttons',
      'ec-msg',
      'ec-fieldset',
      'ec-tabs',
    ]) {
      expect(rule(cls), cls).toContain('width:fit-content;max-width:100%');
    }
    for (const cls of ['ec-title', 'ec-status']) {
      expect(ECIDADE_CSS, cls).not.toMatch(new RegExp(`\\.${cls}[^{]*\\{[^}]*fit-content`));
    }
    expect(ECIDADE_CSS).toMatch(/\.ec-grid\{[^}]*width:100%/);
    const box = BASIC_BLOCKS.find((b) => b.id === 'pb-box')!;
    expect(box.css).toContain('width:fit-content;min-width:120px');
  });

  it('looks like the classic UI: small Arial font and a blue window title', () => {
    expect(ECIDADE_CSS).toMatch(/11px Arial/);
    const title = ECIDADE_BLOCKS.find((b) => b.id === 'ec-title')!;
    expect(title.css).toMatch(/gradient\(#3d78c9/);
    expect(title.html).toContain('Consultas &gt; Consulta Empenho');
  });

  it('covers the specific structures asked for', () => {
    const get = (id: string) => parse(ECIDADE_BLOCKS.find((b) => b.id === id)!.html);
    expect(get('ec-lookup').querySelector('label + input + button')).not.toBeNull();
    expect(get('ec-date').querySelector('input')!.getAttribute('placeholder')).toBe('dd/mm/aaaa');
    expect(get('ec-combo').querySelectorAll('select option').length).toBeGreaterThan(1);
    expect(get('ec-buttons').textContent).toMatch(/IncluirAlterarExcluirPesquisar/);
    expect(get('ec-fieldset').querySelector('fieldset > legend')).not.toBeNull();
    expect(get('ec-grid').querySelectorAll('thead th').length).toBeGreaterThan(1);
    expect(get('ec-grid').querySelectorAll('tbody tr').length).toBeGreaterThan(1);
    expect(get('ec-radios').querySelectorAll('input[type=radio]').length).toBeGreaterThan(1);
    expect(get('ec-check').querySelector('input[type=checkbox]')).not.toBeNull();
    expect(get('ec-tabs').querySelectorAll('.ec-tab').length).toBeGreaterThan(1);
  });

  it('blockContent appends the css as a <style> to be merged by the editor', () => {
    expect(blockContent({ html: '<p>a</p>', css: '' })).toBe('<p>a</p>');
    expect(blockContent({ html: '<p>a</p>', css: 'p{color:red}' })).toBe(
      '<p>a</p><style>p{color:red}</style>',
    );
  });
});
