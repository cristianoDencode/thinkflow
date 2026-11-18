import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import {
  createMemoryRouter,
  Link,
  RouterProvider,
  useLocation,
  useNavigate,
  useSearchParams,
  type RouteObject,
} from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { modalState } from '../../lib/background-location';
import { PageHeader } from '../ui/card';
import { AppContent, type ModalRoute } from './app-content';

const lifecycle = { mounts: 0, unmounts: 0 };

function Chat() {
  const [params, setParams] = useSearchParams();
  const [typed, setTyped] = useState('');
  useEffect(() => {
    lifecycle.mounts++;
    return () => {
      lifecycle.unmounts++;
    };
  }, []);
  return (
    <div>
      <h1>Chat</h1>
      <button type="button" onClick={() => setParams({ c: 'new' }, { replace: true })}>
        Definir conversa
      </button>
      <p data-testid="conversation">{params.get('c') ?? 'nenhuma'}</p>
      <input aria-label="Rascunho" value={typed} onChange={(e) => setTyped(e.target.value)} />
    </div>
  );
}

function Panel() {
  return (
    <div>
      <PageHeader title="Título interno" description="Descrição interna" />
      <button type="button">Dentro do modal</button>
      <Link to="/panel-two">Outro painel</Link>
      <Link to="/history">Ir para o histórico</Link>
    </div>
  );
}

function OpenButtons() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => navigate('/panel', { state: modalState(location) })}>
        Abrir painel
      </button>
      <p data-testid="path">{location.pathname}</p>
    </div>
  );
}

const routes: RouteObject[] = [
  { index: true, element: <Chat /> },
  { path: 'history', element: <h1>Histórico</h1> },
  { path: 'panel', element: <Panel /> },
  { path: 'panel-two', element: <h1>Segundo painel</h1> },
];
const modals: ModalRoute[] = [
  { path: '/panel', title: 'Painel', element: <Panel /> },
  { path: '/panel-two', title: 'Painel dois', element: <h1>Segundo painel</h1> },
];

function setup(initialEntry = '/?c=abc') {
  const router = createMemoryRouter(
    [
      {
        path: '/*',
        element: (
          <>
            <OpenButtons />
            <AppContent routes={routes} modals={modals} />
          </>
        ),
      },
    ],
    { initialEntries: [initialEntry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('AppContent route modals', () => {
  beforeEach(() => {
    lifecycle.mounts = 0;
    lifecycle.unmounts = 0;
  });

  it('opens a menu page as a dialog while the background page stays mounted', async () => {
    const user = userEvent.setup();
    const router = setup();
    await user.type(screen.getByLabelText('Rascunho'), 'texto em andamento');

    await user.click(screen.getByRole('button', { name: 'Abrir painel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Painel' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(router.state.location.pathname).toBe('/panel');
    // the page behind is still there: same instance (no unmount), state and URL params preserved
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByLabelText('Rascunho')).toHaveValue('texto em andamento');
    expect(screen.getByTestId('conversation')).toHaveTextContent('abc');
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
    // title lives in the modal header; the page keeps its description
    expect(screen.queryByRole('heading', { name: 'Título interno' })).toBeNull();
    expect(screen.getByText('Descrição interna')).toBeInTheDocument();
    expect(dialog).toHaveFocus();

    // closing (Escape) goes back to the background without remounting it
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.location.search).toBe('?c=abc');
    expect(screen.getByLabelText('Rascunho')).toHaveValue('texto em andamento');
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });

  it('closes with the X button and with the overlay', async () => {
    const user = userEvent.setup();
    const router = setup();
    await user.click(screen.getByRole('button', { name: 'Abrir painel' }));
    await user.click(await screen.findByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/');

    await user.click(screen.getByRole('button', { name: 'Abrir painel' }));
    await screen.findByRole('dialog');
    const overlay = document.querySelector<HTMLElement>('.backdrop-blur-sm')!;
    await user.click(overlay);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });

  it('browser back closes the modal', async () => {
    const user = userEvent.setup();
    const router = setup();
    await user.click(screen.getByRole('button', { name: 'Abrir painel' }));
    await screen.findByRole('dialog');
    await router.navigate(-1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument();
    expect(lifecycle.unmounts).toBe(0);
  });

  it('a direct visit renders the full page, without dialog or double title', () => {
    setup('/panel');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Título interno' })).toBeInTheDocument();
  });

  it('after a reload (modal entry with no history to pop) closing replaces it by the background', async () => {
    const user = userEvent.setup();
    const router = setup();
    await router.navigate('/panel', {
      replace: true,
      state: modalState(router.state.location),
    });
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.location.search).toBe('?c=abc');
  });

  it('links to the same modal family stay in the modal; other areas close it', async () => {
    const user = userEvent.setup();
    const router = setup();
    await user.click(screen.getByRole('button', { name: 'Abrir painel' }));
    await user.click(await screen.findByRole('link', { name: 'Outro painel' }));
    expect(await screen.findByRole('dialog', { name: 'Painel dois' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/panel-two');
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument();
    expect(lifecycle.unmounts).toBe(0);

    // the in-modal navigation replaced the entry: Back returns to the background directly
    await router.navigate(-1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/');
  });

  it('a link to another area closes the modal and navigates there', async () => {
    const user = userEvent.setup();
    const router = setup();
    await user.click(screen.getByRole('button', { name: 'Abrir painel' }));
    await user.click(await screen.findByRole('link', { name: 'Ir para o histórico' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/history');
    expect(screen.getByRole('heading', { name: 'Histórico' })).toBeInTheDocument();
  });

  it('traps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Abrir painel' }));
    const dialog = await screen.findByRole('dialog');
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('a navigation made by the background page itself (chat setting ?c=) closes the modal without remounting it', async () => {
    const user = userEvent.setup();
    const router = setup('/');
    await user.click(screen.getByRole('button', { name: 'Abrir painel' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Definir conversa' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.search).toBe('?c=new');
    expect(screen.getByTestId('conversation')).toHaveTextContent('new');
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });
});
