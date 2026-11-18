import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PrototypeDetailDto, TestSessionDto, TestStep } from '@thinkflow/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { json as testJson, sessionDetail, sessionSummary } from '../tests/fixtures';
import { detail } from './fixtures';
import { RenderImageButton, SendToDocumentDialog } from './send-to-document-dialog';

const note = (id: string, comment: string): TestStep => ({
  id,
  at: 1,
  kind: 'note',
  target: null,
  page: null,
  comment,
});

const session = (over: Partial<TestSessionDto> = {}): TestSessionDto =>
  sessionDetail({
    id: 's1',
    name: 'Cadastro',
    definition: {
      ...sessionDetail().definition,
      steps: [
        note('a', 'Abrir o menu'),
        { ...note('b', ''), kind: 'capture', title: 'Tela inicial' },
        note('c', 'Fechar'),
      ],
    },
    images: {
      b: {
        id: 'e1',
        sessionId: 's1',
        stepId: 'b',
        seq: 1,
        at: 1,
        width: 100,
        height: 80,
        annotations: [{ type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2, color: '#f00' }],
        crop: null,
        annotated: true,
        comment: '',
        include: true,
        updatedAt: 1,
        originalUrl: '/api/tests/sessions/s1/images/o.png',
        imageUrl: '/api/tests/sessions/s1/images/a.png',
      },
    },
    ...over,
  });

const renderOk = {
  thumbnailUrl: '/api/prototypes/p1/thumbnail?v=1',
  width: 1280,
  height: 720,
  scale: 1,
  renderedVersionId: 'v2',
  cached: false,
  blockedRequests: 0,
};

let calls: { method: string; url: string; body: unknown }[];
let sessionState: 'idle' | 'recording';
let sendStatus: number;

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  calls = [];
  sessionState = 'idle';
  sendStatus = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url === '/api/tests/sessions')
        return testJson([
          sessionSummary({ id: 's1', name: 'Cadastro', state: sessionState }),
          sessionSummary({ id: 's2', name: 'Outra sessão' }),
        ]);
      if (url === '/api/tests/sessions/s1') return testJson(session());
      if (url === '/api/tests/sessions/s2')
        return testJson(session({ id: 's2', name: 'Outra sessão' }));
      if (url.startsWith('/api/prototypes/p1/render')) {
        if (sendStatus === 503)
          return testJson(
            { error: { code: 'renderer_unavailable', message: 'Chromium indisponível' } },
            503,
          );
        return testJson({ ...renderOk, ...(url.includes('scale=2') ? { scale: 2 } : {}) });
      }
      if (url === '/api/prototypes/p1/send-to-session')
        return testJson({
          sessionId: body.sessionId,
          stepId: body.stepId ?? 'novo',
          target: body.target,
          render: renderOk,
          sentTo: [],
        });
      return testJson({}, 404);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const sends = () => calls.filter((c) => c.url === '/api/prototypes/p1/send-to-session');
const linked = (over: Partial<PrototypeDetailDto> = {}) =>
  detail({ sessionId: 's1', sessionName: 'Cadastro', ...over });

describe('SendToDocumentDialog', () => {
  it('defaults to the linked session and sends a new step at the end after rendering', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    wrap(<SendToDocumentDialog prototype={linked()} onDone={onDone} />);
    await screen.findByRole('option', { name: 'Cadastro' });
    expect(screen.getByLabelText('Sessão de teste')).toHaveValue('s1');
    expect(screen.getByPlaceholderText('Protótipo: Consulta Empenho')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Gerar imagem e enviar' }));
    expect(await screen.findByText(/enviada como um novo passo/)).toBeInTheDocument();
    expect(calls.findIndex((c) => c.url === '/api/prototypes/p1/render')).toBeLessThan(
      calls.findIndex((c) => c.url === '/api/prototypes/p1/send-to-session'),
    );
    expect(sends()[0]!.body).toEqual({
      sessionId: 's1',
      target: 'newStep',
      scale: 1,
      include: true,
    });
    const link = screen.getByRole('link', { name: /Abrir em Passos/ });
    expect(link).toHaveAttribute('href', '/tests/s1#step-novo');

    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ stepId: 'novo' }));
  });

  it('needs a session when the prototype is not linked', async () => {
    const user = userEvent.setup();
    wrap(<SendToDocumentDialog prototype={detail()} />);
    await screen.findByRole('option', { name: 'Outra sessão' });
    const send = screen.getByRole('button', { name: 'Gerar imagem e enviar' });
    expect(send).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Sessão de teste'), 's2');
    expect(send).toBeEnabled();
  });

  it('inserts after a chosen step with a custom title and the include switch off', async () => {
    const user = userEvent.setup();
    wrap(<SendToDocumentDialog prototype={linked()} />);
    await screen.findByRole('option', { name: 'Cadastro' });
    await user.click(screen.getByLabelText('Novo passo depois de um passo'));
    const send = screen.getByRole('button', { name: 'Gerar imagem e enviar' });
    expect(send).toBeDisabled();
    const picker = await screen.findByRole('radiogroup', { name: 'Passo anterior' });
    expect(within(picker).getAllByRole('radio')).toHaveLength(3);
    await user.click(within(picker).getByLabelText('Passo 1: Abrir o menu'));
    await user.type(screen.getByLabelText('Título do passo'), 'Tela de consulta');
    await user.click(screen.getByRole('switch', { name: 'Mostrar a imagem no documento' }));
    await user.selectOptions(screen.getByLabelText('Qualidade da imagem'), '2');
    await user.click(send);
    await screen.findByText(/enviada como um novo passo/);
    expect(sends()[0]!.body).toEqual({
      sessionId: 's1',
      target: 'newStep',
      scale: 2,
      afterStepId: 'a',
      title: 'Tela de consulta',
      include: false,
    });
    expect(calls.some((c) => c.url === '/api/prototypes/p1/render?scale=2')).toBe(true);
  });

  it('replaces the image of a step only after confirming that annotations are dropped', async () => {
    const user = userEvent.setup();
    wrap(<SendToDocumentDialog prototype={linked()} />);
    await screen.findByRole('option', { name: 'Cadastro' });
    await user.click(screen.getByLabelText('Substituir a imagem de um passo'));
    const picker = await screen.findByRole('radiogroup', { name: 'Passo a substituir' });
    await user.click(within(picker).getByLabelText('Passo 2: Tela inicial'));
    const send = screen.getByRole('button', { name: 'Gerar imagem e enviar' });
    expect(send).toBeDisabled();
    expect(screen.getByText(/Mantém a escolha atual/)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Confirmo a substituição/));
    expect(send).toBeEnabled();
    await user.click(send);
    await screen.findByText(/Imagem do passo substituída/);
    // no `include` and no title: the step keeps its own choice
    expect(sends()[0]!.body).toEqual({
      sessionId: 's1',
      target: 'replaceStepImage',
      scale: 1,
      stepId: 'b',
    });
    expect(screen.getByRole('link', { name: /Abrir em Passos/ })).toHaveAttribute(
      'href',
      '/tests/s1#step-b',
    );
  });

  it('blocks a session that is recording and shows the error of a failed render', async () => {
    const user = userEvent.setup();
    sessionState = 'recording';
    wrap(<SendToDocumentDialog prototype={linked()} />);
    await screen.findByText(/gravando ou executando/);
    expect(screen.getByRole('button', { name: 'Gerar imagem e enviar' })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Sessão de teste'), 's2');
    sendStatus = 503;
    await user.click(screen.getByRole('button', { name: 'Gerar imagem e enviar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Chromium indisponível');
    expect(sends()).toHaveLength(0);
    // can try again
    expect(screen.getByRole('button', { name: 'Gerar imagem e enviar' })).toBeEnabled();
  });
});

describe('RenderImageButton', () => {
  it('renders, previews the PNG and offers it for download', async () => {
    const user = userEvent.setup();
    wrap(<RenderImageButton prototype={{ id: 'p1', name: 'Consulta Empenho' }} />);
    await user.click(screen.getByRole('button', { name: /Gerar imagem/ }));
    const img = await screen.findByAltText('Imagem de Consulta Empenho');
    expect(img).toHaveAttribute('src', renderOk.thumbnailUrl);
    expect(screen.getByText(/1280 × 720 px/)).toBeInTheDocument();
    const download = screen.getByRole('link', { name: /Baixar PNG/ });
    expect(download).toHaveAttribute('href', renderOk.thumbnailUrl);
    expect(download).toHaveAttribute('download', 'Consulta-Empenho.png');
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/prototypes/p1/render' });

    await user.click(screen.getByRole('button', { name: 'Gerar novamente' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/prototypes/p1/render?force=true')).toBe(true),
    );
  });

  it('shows the server message when Chromium is unavailable', async () => {
    const user = userEvent.setup();
    sendStatus = 503;
    wrap(<RenderImageButton prototype={{ id: 'p1', name: 'X' }} />);
    await user.click(screen.getByRole('button', { name: /Gerar imagem/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Chromium indisponível');
    expect(screen.queryByRole('link', { name: /Baixar PNG/ })).toBeNull();
  });
});
