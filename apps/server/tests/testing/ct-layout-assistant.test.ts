import { DEFAULT_CT_LAYOUT, ctLayoutSchema, type CtLayout } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/shared/kernel/errors';
import type { RouteChatRequest } from '../../src/contexts/routing/application/route-chat-request';
import { CtLayoutAssistant } from '../../src/contexts/testing/application/ct-layout-assistant';
import { layoutFromJson } from '../../src/contexts/testing/domain/ct-layout-prompt';

interface Reply {
  text?: string;
  fail?: { reason: string; message: string };
}
interface Seen {
  body: Record<string, unknown>;
  options: { source: string; privacy?: { scope?: string } };
}

/** Plays `replies` in order; `seen` keeps every request as the router would get it. */
function fakeRouter(replies: Reply[]) {
  const seen: Seen[] = [];
  const router = {
    execute: async (request: { body: Record<string, unknown> }, options: Seen['options']) => {
      seen.push({ body: request.body, options });
      const reply = replies.shift() ?? { text: '{}' };
      if (reply.fail) return { ok: false, status: 502, attempts: [], ...reply.fail };
      async function* events() {
        yield { choices: [{ index: 0, delta: { content: reply.text ?? '' } }] };
        yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      }
      return {
        ok: true,
        stream: { format: 'openai', events: events() },
        providerId: 'fake',
        model: 'fake/model',
        finish: () => undefined,
      };
    },
  } as unknown as RouteChatRequest;
  return { router, seen };
}

const LOGO = 'data:image/png;base64,iVBORw0KGgo=';

function make(replies: Reply[]) {
  const { router, seen } = fakeRouter(replies);
  let n = 0;
  const forgotten: string[] = [];
  const assistant = new CtLayoutAssistant({
    router,
    ids: { next: () => `id${++n}` },
    forgetPrivacyScope: (scope) => void forgotten.push(scope),
  });
  return { assistant, seen, forgotten };
}

const draft = {
  name: 'Verde sóbrio',
  explanation: 'Tons de verde com fonte serifada.',
  layout: {
    title: 'Caso de Teste',
    kicker: '',
    headerText: 'Qualidade',
    footerText: 'Documento interno',
    primaryColor: '#1B5E20',
    accentColor: '#2E7D32',
    fontFamily: 'Georgia',
    logoPosition: 'right',
    showHeader: true,
    showFooter: true,
  },
};

describe('layoutFromJson', () => {
  it('normalizes colors and font names, clips long texts and ignores any logo from the model', () => {
    const result = layoutFromJson(
      {
        name: 'x',
        layout: {
          primaryColor: '1b5e20',
          accentColor: '#abc',
          fontFamily: 'georgia',
          title: 'T'.repeat(500),
          logo: 'data:image/png;base64,EVIL',
        },
      },
      { ...DEFAULT_CT_LAYOUT, logo: LOGO },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layout.primaryColor).toBe('#1b5e20');
    expect(result.layout.accentColor).toBe('#aabbcc');
    expect(result.layout.fontFamily).toBe('Georgia');
    expect(result.layout.title).toHaveLength(80);
    expect(result.layout.logo).toBe(LOGO);
  });

  it('reports what is wrong', () => {
    const result = layoutFromJson(
      { layout: { primaryColor: 'azul', fontFamily: 'Comic Sans' } },
      DEFAULT_CT_LAYOUT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join('\n')).toContain('primaryColor');
    expect(result.issues.join('\n')).toContain('fontFamily');
  });
});

describe('CtLayoutAssistant', () => {
  it('returns a validated draft from a fenced JSON answer, never with a logo', async () => {
    const { assistant, seen, forgotten } = make([
      { text: 'Claro!\n```json\n' + JSON.stringify(draft) + '\n```' },
    ]);
    const result = await assistant.assist({ prompt: 'algo verde e sóbrio' });
    expect(result.name).toBe('Verde sóbrio');
    expect(ctLayoutSchema.safeParse(result.layout).success).toBe(true);
    expect(result.layout).toMatchObject({
      primaryColor: '#1B5E20',
      fontFamily: 'Georgia',
      logo: null,
    });
    expect(result.explanation).toContain('verde');
    expect(result.model).toBe('fake/model');
    // pt-BR prompt that says only the look is designed
    const system = JSON.stringify(seen[0]!.body.messages);
    expect(system).toContain('SOMENTE a aparência');
    expect(system).toContain('NÃO as altera');
    expect(seen[0]!.options.source).toBe('ct-layout-assistant');
    // the privacy vault of the request is dropped afterwards
    expect(forgotten).toEqual([seen[0]!.options.privacy?.scope ?? forgotten[0]]);
    expect(forgotten[0]).toMatch(/^ct-layout-assistant:/);
  });

  it('refines the current layout, keeps its logo and does not send the logo to the model', async () => {
    const current: CtLayout = { ...DEFAULT_CT_LAYOUT, logo: LOGO, headerText: 'Acme' };
    const { assistant, seen } = make([
      { text: JSON.stringify({ name: 'v2', layout: { primaryColor: '#000000' } }) },
    ]);
    const result = await assistant.assist({ prompt: 'mais escuro', layout: current });
    expect(result.layout.logo).toBe(LOGO);
    expect(result.layout.headerText).toBe('Acme');
    expect(result.layout.primaryColor).toBe('#000000');
    const user = JSON.stringify(seen[0]!.body.messages);
    expect(user).toContain('Acme');
    expect(user).not.toContain('iVBORw0KGgo');
  });

  it('retries once telling the model what was wrong', async () => {
    const { assistant, seen } = make([
      { text: JSON.stringify({ layout: { primaryColor: 'azul' } }) },
      { text: JSON.stringify(draft) },
    ]);
    const result = await assistant.assist({ prompt: 'verde' });
    expect(result.layout.primaryColor).toBe('#1B5E20');
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen[1]!.body.messages)).toContain('resposta anterior era inválida');
  });

  it('gives a friendly error when the answer stays invalid, and when the provider fails', async () => {
    const bad = make([{ text: 'não sei' }, { text: 'ainda não sei' }]);
    await expect(bad.assistant.assist({ prompt: 'verde' })).rejects.toMatchObject({
      code: 'ct_layout_invalid_answer',
    });
    expect(bad.forgotten).toHaveLength(1);

    const down = make([{ fail: { reason: 'rate_limited', message: 'limit' } }]);
    const err = await down.assistant.assist({ prompt: 'verde' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).httpStatus).toBe(429);
    expect((err as DomainError).message).toContain('limitando');
  });

  it('validates the request', async () => {
    const { assistant } = make([]);
    await expect(assistant.assist({ prompt: '' })).rejects.toThrow();
  });
});
