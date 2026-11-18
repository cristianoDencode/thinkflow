import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './sidebar';

function setup(onCloseMobile = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <QueryClientProvider client={client}>
            <Sidebar
              collapsed
              onToggleCollapsed={() => {}}
              mobileOpen={false}
              onCloseMobile={onCloseMobile}
            />
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
  return { router, onCloseMobile };
}

describe('Sidebar user menu', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens with the items and Sair, closes on Escape and returns focus', async () => {
    const user = userEvent.setup();
    setup();
    const button = screen.getByRole('button', { name: 'Menu do usuário' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent?.trim());
    expect(items).toEqual(['Uso', 'Conexões', 'MCP', 'Database', 'Configurações', 'Ajuda', 'Sair']);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('lists the primary items with Dados com IA right after Pergunte à AI', () => {
    setup();
    const links = screen.getAllByRole('link').map((l) => l.getAttribute('title') ?? l.textContent);
    expect(links.slice(0, 3)).toEqual(['Pergunte à AI', 'Dados com IA', 'Histórico']);
    expect(screen.getByRole('link', { name: /Dados com IA/ })).toHaveAttribute('href', '/dados');
  });

  it('opens Database as a modal over the current screen', async () => {
    const user = userEvent.setup();
    const { router } = setup();
    await user.click(screen.getByRole('button', { name: 'Menu do usuário' }));
    await user.click(screen.getByRole('menuitem', { name: /Database/ }));
    expect(router.state.location.pathname).toBe('/databases');
    expect(router.state.location.state).toMatchObject({ backgroundLocation: { pathname: '/' } });
  });

  it('closes on outside click', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Menu do usuário' }));
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('navigates, closes and calls onCloseMobile', async () => {
    const user = userEvent.setup();
    const { router, onCloseMobile } = setup();
    await user.click(screen.getByRole('button', { name: 'Menu do usuário' }));
    await user.click(screen.getByRole('menuitem', { name: /Conexões/ }));
    expect(router.state.location.pathname).toBe('/connections');
    // opened over the screen it came from, and focus waits on the menu button for the modal to return to
    expect(router.state.location.state).toMatchObject({
      backgroundLocation: { pathname: '/' },
    });
    expect(screen.getByRole('button', { name: 'Menu do usuário' })).toHaveFocus();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onCloseMobile).toHaveBeenCalled();
  });

  it('keeps the page behind a menu modal as the active nav item', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByRole('link', { name: /Pergunte à AI/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(screen.getByRole('button', { name: 'Menu do usuário' }));
    await user.click(screen.getByRole('menuitem', { name: /Uso/ }));
    expect(screen.getByRole('link', { name: /Pergunte à AI/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
