import { describe, expect, it } from 'vitest';
import {
  CT_LAYOUT_FONTS,
  DEFAULT_CT_LAYOUT,
  ctLayoutAssistSchema,
  ctLayoutSchema,
  ctModelInputSchema,
} from './ct-layout';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('ctLayoutSchema', () => {
  it('has a neutral default: no logo, no client texts', () => {
    expect(DEFAULT_CT_LAYOUT).toMatchObject({
      title: 'Caso de Teste',
      logo: null,
      showHeader: true,
      showFooter: true,
      fontFamily: 'Calibri',
      logoPosition: 'right',
    });
    expect(DEFAULT_CT_LAYOUT.headerText).toBe('Caso de Teste');
    expect(DEFAULT_CT_LAYOUT.footerText).toBe('');
  });

  it('accepts a full custom layout', () => {
    const layout = ctLayoutSchema.parse({
      title: 'Meu documento',
      kicker: '',
      headerText: 'Acme',
      footerText: 'Interno',
      primaryColor: '#112233',
      accentColor: '#aabbcc',
      fontFamily: 'Verdana',
      logo: PNG,
      logoPosition: 'left',
      showHeader: false,
      showFooter: false,
    });
    expect(layout.logo).toBe(PNG);
    expect(layout.showHeader).toBe(false);
  });

  it('rejects bad colors, fonts outside the allowlist and an empty title', () => {
    expect(ctLayoutSchema.safeParse({ primaryColor: 'red' }).success).toBe(false);
    expect(ctLayoutSchema.safeParse({ accentColor: '#fff' }).success).toBe(false);
    expect(ctLayoutSchema.safeParse({ fontFamily: 'Comic Sans' }).success).toBe(false);
    expect(ctLayoutSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(ctLayoutSchema.safeParse({ fontFamily: CT_LAYOUT_FONTS[1] }).success).toBe(true);
  });

  it('rejects a logo that is not PNG/JPEG or is over 200 KB', () => {
    expect(ctLayoutSchema.safeParse({ logo: 'data:image/svg+xml;base64,AAAA' }).success).toBe(
      false,
    );
    expect(ctLayoutSchema.safeParse({ logo: 'https://x.test/a.png' }).success).toBe(false);
    expect(ctLayoutSchema.safeParse({ logo: 'data:image/png;base64,<script>' }).success).toBe(
      false,
    );
    const huge = `data:image/png;base64,${'A'.repeat(300_000)}`;
    expect(ctLayoutSchema.safeParse({ logo: huge }).success).toBe(false);
    expect(ctLayoutSchema.safeParse({ logo: 'data:image/jpeg;base64,/9j/4AAQ' }).success).toBe(
      true,
    );
  });
});

describe('model and assist inputs', () => {
  it('a model needs a name', () => {
    expect(ctModelInputSchema.safeParse({ name: ' ', layout: {} }).success).toBe(false);
    expect(ctModelInputSchema.parse({ name: ' Azul ', layout: {} }).name).toBe('Azul');
  });

  it('the AI request needs a description; the layout to refine is optional', () => {
    expect(ctLayoutAssistSchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(ctLayoutAssistSchema.safeParse({ prompt: 'tema verde e sóbrio' }).success).toBe(true);
    expect(
      ctLayoutAssistSchema.safeParse({ prompt: 'mais escuro', layout: { primaryColor: 'x' } })
        .success,
    ).toBe(false);
  });
});
