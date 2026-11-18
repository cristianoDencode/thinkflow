import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_CT_LAYOUT, type CtLayout, type CtModelDto } from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { json } from './fixtures';
import { CtModelSelector } from './ct-model-selector';
import { CtModelsDialog } from './ct-models-dialog';

const BUILT_IN: CtModelDto = {
  id: 'default',
  name: 'Padrão',
  builtIn: true,
  layout: DEFAULT_CT_LAYOUT,
  createdAt: 0,
  updatedAt: 0,
};
const ACME_LAYOUT: CtLayout = { ...DEFAULT_CT_LAYOUT, headerText: 'Acme', primaryColor: '#AA1122' };
const ACME: CtModelDto = {
  id: 'm1',
  name: 'Acme',
  builtIn: false,
  layout: ACME_LAYOUT,
  createdAt: 1,
  updatedAt: 1,
};

let models: CtModelDto[];
let calls: { method: string; url: string; body?: Record<string, unknown> }[];

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  models = [BUILT_IN, ACME];
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : undefined;
      calls.push({ method, url, ...(body ? { body } : {}) });
      if (url === '/api/tests/ct-models' && method === 'GET') return json(models);
      if (url === '/api/tests/ct-models' && method === 'POST') {
        const created: CtModelDto = {
          id: 'm2',
          name: String(body!.name),
          builtIn: false,
          layout: body!.layout as CtLayout,
          createdAt: 2,
          updatedAt: 2,
        };
        models = [...models, created];
        return json(created, 201);
      }
      if (url === '/api/tests/ct-models/preview')
        return json({ html: '<html><body>amostra</body></html>' });
      if (url === '/api/tests/ct-models/assist')
        return json({
          name: 'Verde sóbrio',
          layout: { ...DEFAULT_CT_LAYOUT, primaryColor: '#1B5E20' },
          explanation: 'Tons de verde.',
          model: 'x',
          warnings: [],
        });
      if (url === '/api/tests/ct-models/m1' && method === 'DELETE') {
        models = models.filter((m) => m.id !== 'm1');
        return json({ ok: true });
      }
      if (url === '/api/models') return json([{ id: 'groq/llama', label: 'Llama' }]);
      if (url === '/api/tests/sessions/s1/ct/model' && method === 'PUT')
        return json({ modelId: body!.modelId });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CtModelSelector', () => {
  it('lists "Padrão" and the saved models and saves the choice for the session', async () => {
    const changed = vi.fn();
    wrap(<CtModelSelector sessionId="s1" modelId="default" disabled={false} onChanged={changed} />);
    const select = await screen.findByLabelText('Modelo');
    await screen.findByRole('option', { name: 'Acme' });
    expect(screen.getByRole('option', { name: 'Padrão' })).toBeTruthy();
    expect(select).toHaveProperty('value', 'default');

    await userEvent.selectOptions(select, 'm1');
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/api/tests/sessions/s1/ct/model',
      body: { modelId: 'm1' },
    });
  });

  it('shows "Padrão" even when the list cannot be loaded', async () => {
    models = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { message: 'x' } }, 500)),
    );
    wrap(<CtModelSelector sessionId="s1" modelId="default" disabled={false} onChanged={vi.fn()} />);
    expect(await screen.findByRole('option', { name: 'Padrão' })).toBeTruthy();
  });

  it('opens the manager', async () => {
    wrap(<CtModelSelector sessionId="s1" modelId="default" disabled={false} onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /Modelos/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Modelos do documento')).toBeTruthy();
  });
});

describe('CtModelsDialog', () => {
  it('the built-in model is read-only; duplicating it makes an editable copy', async () => {
    wrap(<CtModelsDialog open onClose={vi.fn()} currentId="default" />);
    await userEvent.click(await screen.findByRole('button', { name: /Padrão/ }));
    expect(await screen.findByLabelText('Nome do modelo')).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: /Salvar modelo/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Excluir/ })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Duplicar/ }));
    const name = screen.getByLabelText('Nome do modelo');
    expect(name).toHaveProperty('value', 'Padrão (cópia)');
    expect(name).toHaveProperty('disabled', false);
  });

  it('creates a model from the form and saves it', async () => {
    wrap(<CtModelsDialog open onClose={vi.fn()} currentId="default" />);
    await userEvent.click(await screen.findByRole('button', { name: /Novo modelo/ }));
    const name = screen.getByLabelText('Nome do modelo');
    await userEvent.clear(name);
    await userEvent.type(name, 'Meu visual');
    const header = screen.getByLabelText('Texto do cabeçalho');
    await userEvent.clear(header);
    await userEvent.type(header, 'Minha empresa');
    await userEvent.selectOptions(screen.getByLabelText('Fonte'), 'Georgia');
    await userEvent.click(screen.getByRole('button', { name: /Salvar modelo/ }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/tests/ct-models')).toBe(true),
    );
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/tests/ct-models')!;
    expect(post.body).toMatchObject({
      name: 'Meu visual',
      layout: { headerText: 'Minha empresa', fontFamily: 'Georgia', logo: null },
    });
    expect(await screen.findByRole('button', { name: /Meu visual/ })).toBeTruthy();
  });

  it('shows a live preview rendered by the server', async () => {
    wrap(<CtModelsDialog open onClose={vi.fn()} currentId="default" />);
    await userEvent.click(await screen.findByRole('button', { name: /Acme/ }));
    const frame = await screen.findByTitle('Pré-visualização do modelo');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('amostra');
    expect(calls.find((c) => c.url.endsWith('/preview'))?.body).toMatchObject({
      layout: { headerText: 'Acme' },
    });
  });

  it('"Criar com IA" puts the draft in the editor without saving it', async () => {
    wrap(<CtModelsDialog open onClose={vi.fn()} currentId="default" />);
    await userEvent.type(await screen.findByLabelText('Criar modelo com IA'), 'verde sóbrio');
    await userEvent.click(screen.getByRole('button', { name: /Gerar modelo/ }));
    expect(await screen.findByLabelText('Nome do modelo')).toHaveProperty('value', 'Verde sóbrio');
    expect(screen.getByLabelText('Cor principal')).toHaveProperty('value', '#1B5E20');
    expect(screen.getByText(/Tons de verde/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/tests/ct-models')).toBe(false);
    expect(calls.find((c) => c.url.endsWith('/assist'))?.body).toMatchObject({
      prompt: 'verde sóbrio',
    });
  });

  it('deletes a saved model after confirming', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    wrap(<CtModelsDialog open onClose={vi.fn()} currentId="default" />);
    await userEvent.click(await screen.findByRole('button', { name: /Acme/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Excluir/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Acme/ })).toBeNull());
  });
});
