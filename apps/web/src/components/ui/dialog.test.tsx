import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Dialog } from './dialog';

function Nested() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(false);
  return (
    <Dialog open={outer} onClose={() => setOuter(false)} title="Externo" size="xl">
      <button type="button" onClick={() => setInner(true)}>
        Abrir interno
      </button>
      <Dialog open={inner} onClose={() => setInner(false)} title="Interno">
        <button type="button">Ação interna</button>
      </Dialog>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('Escape closes only the topmost of nested dialogs', async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByRole('button', { name: 'Abrir interno' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    await user.keyboard('{Escape}');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Externo' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is labelled, focuses the panel and restores focus on close', async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Abrir
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Grande" size="xl">
            <p>Conteúdo</p>
          </Dialog>
        </>
      );
    }
    render(<Host />);
    const trigger = screen.getByRole('button', { name: 'Abrir' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Grande' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });
});
