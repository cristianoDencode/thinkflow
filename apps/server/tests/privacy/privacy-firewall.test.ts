import { describe, expect, it } from 'vitest';
import { PrivacyFirewall } from '../../src/contexts/privacy/application/privacy-firewall';
import { EphemeralVaultCache } from '../../src/contexts/privacy/application/ephemeral-vault-cache';
import type { VaultStore } from '../../src/contexts/privacy/domain/ports';
import { InMemoryVault, type Vault } from '../../src/contexts/privacy/domain/vault';
import type { Span } from '../../src/contexts/privacy/domain/pii';
import type { RoutableRequest } from '../../src/contexts/routing/domain/types';

const CPF = '529.982.247-25';
const EMAIL = 'joao.silva@exemplo.com.br';
const PHONE = '(11) 99999-8888';
const NAME = 'JOAO DA SILVA';
const SEEDS = [CPF, '52998224725', EMAIL, PHONE, NAME];

class MemoryStore implements VaultStore {
  readonly vaults = new Map<string, InMemoryVault>();
  forScope(id: string): Vault {
    const v = this.vaults.get(id) ?? new InMemoryVault();
    this.vaults.set(id, v);
    return v;
  }
  deleteScope(id: string): void {
    this.vaults.delete(id);
  }
  copyScope(): void {}
}

function firewall(
  extra: Partial<ConstructorParameters<typeof PrivacyFirewall>[0]> = {},
  enabled = true,
) {
  const store = new MemoryStore();
  return {
    store,
    fw: new PrivacyFirewall({
      vaults: store,
      settings: () => ({ enabled, presidioUrl: '', minScore: 0.5 }),
      ...extra,
    }),
  };
}

const raw = (r: RoutableRequest) => JSON.stringify(r.body);
const expectClean = (r: RoutableRequest) => {
  const text = raw(r);
  for (const seed of SEEDS) expect(text).not.toContain(seed);
};

describe('PrivacyFirewall.protect (OpenAI)', () => {
  const body = () => ({
    model: 'auto',
    messages: [
      { role: 'system', content: `Atenda ${NAME}, CPF ${CPF}.` },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Meu e-mail é ${EMAIL} e o fone ${PHONE}` },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
      {
        role: 'assistant',
        content: `Anotei ${NAME}.`,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: {
              name: 'consultar',
              arguments: JSON.stringify({ cpf: CPF, filtro: { nome: NAME }, n: 3 }),
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: `{"nome":"${NAME}","cpf":"${CPF}"}` },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'consultar',
          description: `Consulta, ex.: ${CPF}`,
          parameters: {
            type: 'object',
            properties: { cpf: { type: 'string', description: `Ex.: ${EMAIL}` } },
          },
        },
      },
    ],
  });

  it('leaves no raw value anywhere and keeps the structure intact', async () => {
    const { fw } = firewall();
    const original = body();
    const snapshot = JSON.stringify(original);
    const result = await fw.protect({ format: 'openai', body: original }, new InMemoryVault());
    expectClean(result.request);
    expect(JSON.stringify(original)).toBe(snapshot); // input untouched
    const out = result.request.body as ReturnType<typeof body>;
    const args = JSON.parse(out.messages[2]!.tool_calls![0]!.function.arguments) as {
      cpf: string;
      filtro: { nome: string };
      n: number;
    };
    expect(args.cpf).toMatch(/^\[CPF_\d+\]$/);
    expect(args.filtro.nome).toMatch(/^\[NOME_\d+\]$/);
    expect(args.n).toBe(3);
    expect(out.messages[3]!.tool_call_id).toBe('c1');
    expect(result.imagesUnfiltered).toBe(1);
    expect(result.tokenized.CPF).toBeGreaterThan(0);
    expect(result.tokenized.EMAIL).toBeGreaterThan(0);
  });

  it('never alters tool-call extra_content', async () => {
    const { fw } = firewall();
    // opaque base64 that happens to contain digit runs, a CPF-looking run and an e-mail-like tail
    const signature = `Cm0BjzGxK52998224725AbCd${CPF.replace(/\D/g, '')}+/xyz11999998888Zg==`;
    const extra = { google: { thought_signature: signature }, other_signature: EMAIL };
    const original = {
      model: 'auto',
      messages: [
        { role: 'user', content: `CPF ${CPF}` },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'consultar', arguments: '{"n":1}' },
              extra_content: extra,
            },
          ],
        },
      ],
    };
    const result = await fw.protect({ format: 'openai', body: original }, new InMemoryVault());
    const out = result.request.body as typeof original;
    expect(out.messages[0]!.content).toMatch(/\[CPF_\d+\]/);
    expect(
      (out.messages[1] as { tool_calls: { extra_content: unknown }[] }).tool_calls[0]!
        .extra_content,
    ).toEqual(extra);
  });

  it('gives the same value the same token, in any formatting', async () => {
    const { fw } = firewall();
    const vault = new InMemoryVault();
    const r = await fw.protect(
      {
        format: 'openai',
        body: { messages: [{ role: 'user', content: `${CPF} e 52998224725 e ${CPF}` }] },
      },
      vault,
    );
    const content = (r.request.body.messages as { content: string }[])[0]!.content;
    expect(content).toBe('[CPF_1] e [CPF_1] e [CPF_1]');
  });

  it('does not touch text that already is a token', async () => {
    const { fw } = firewall();
    const r = await fw.protect(
      { format: 'openai', body: { messages: [{ role: 'user', content: '[CPF_1] e [NOME_2]' }] } },
      new InMemoryVault(),
    );
    expect((r.request.body.messages as { content: string }[])[0]!.content).toBe(
      '[CPF_1] e [NOME_2]',
    );
  });

  it('re-tokenizes a value known only to the vault (known-values pass)', async () => {
    const { fw, store } = firewall();
    const vault = store.forScope('conv-1');
    const token = vault.tokenFor('ENDERECO', 'Rua Xingu 123');
    const r = await fw.protect(
      {
        format: 'openai',
        body: {
          messages: [
            { role: 'assistant', content: 'O imóvel fica na rua xingu  123, centro.' },
            { role: 'user', content: 'ok' },
          ],
        },
      },
      vault,
    );
    expect((r.request.body.messages as { content: string }[])[0]!.content).toBe(
      `O imóvel fica na ${token}, centro.`,
    );
  });

  it('known CPF in another format also goes back as its token', async () => {
    const { fw, store } = firewall();
    const vault = store.forScope('conv-2');
    const token = vault.tokenFor('CPF', '52998224725');
    const r = await fw.protect(
      {
        format: 'openai',
        body: { messages: [{ role: 'user', content: 'veja 529.982.247-25 de novo' }] },
      },
      vault,
    );
    expect((r.request.body.messages as { content: string }[])[0]!.content).toBe(
      `veja ${token} de novo`,
    );
  });

  it('merges extra spans and degrades (native only) when the provider fails', async () => {
    const extra = async (text: string): Promise<Span[]> => {
      const at = text.indexOf('Santa Rita');
      return at < 0
        ? []
        : [{ start: at, end: at + 10, kind: 'ENDERECO', score: 0.9, source: 'presidio' }];
    };
    const { fw } = firewall({ extraSpans: extra });
    const r = await fw.protect(
      {
        format: 'openai',
        body: { messages: [{ role: 'user', content: `Mora em Santa Rita, ${CPF}` }] },
      },
      new InMemoryVault(),
    );
    expect(raw(r.request)).not.toContain('Santa Rita');
    expect(raw(r.request)).not.toContain(CPF);
    expect(r.degraded).toBe(false);

    const failing = firewall({
      extraSpans: async () => {
        throw new Error('down');
      },
    }).fw;
    const d = await failing.protect(
      { format: 'openai', body: { messages: [{ role: 'user', content: `CPF ${CPF}` }] } },
      new InMemoryVault(),
    );
    expect(raw(d.request)).not.toContain(CPF);
    expect(d.degraded).toBe(true);
  });
});

describe('PrivacyFirewall.protect (Anthropic)', () => {
  it('covers system, text, tool_result, tool_use input and counts images', async () => {
    const { fw } = firewall();
    const body = {
      model: 'auto',
      system: [{ type: 'text', text: `Usuário ${NAME}` }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `CPF ${CPF}, ${EMAIL}` },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 'sig' },
            { type: 'tool_use', id: 't1', name: 'lookup', input: { phone: PHONE, q: [NAME] } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: `Nome: ${NAME}` },
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: `fone ${PHONE}` }],
            },
          ],
        },
      ],
      tools: [{ name: 'lookup', description: `ex ${EMAIL}`, input_schema: { type: 'object' } }],
    };
    const r = await fw.protect({ format: 'anthropic', body }, new InMemoryVault());
    expectClean(r.request);
    expect(r.imagesUnfiltered).toBe(1);
    const out = r.request.body as typeof body;
    expect((out.messages[1]!.content[0] as { signature: string }).signature).toBe('sig');
    expect((out.messages[1]!.content[1] as { input: { phone: string } }).input.phone).toMatch(
      /^\[TELEFONE_\d+\]$/,
    );
  });
});

describe('EphemeralVaultCache', () => {
  it('keeps a vault per key, expires by TTL and caps the number of scopes', () => {
    let now = 0;
    const cache = new EphemeralVaultCache({ ttlMs: 1000, maxScopes: 2, now: () => now });
    const a = cache.get('a');
    expect(cache.get('a')).toBe(a);
    cache.get('b');
    cache.get('c'); // evicts the least recently used ('a')
    expect(cache.size).toBe(2);
    expect(cache.get('a')).not.toBe(a);
    const b = cache.get('b');
    now += 2000;
    expect(cache.get('b')).not.toBe(b); // expired
  });
});
