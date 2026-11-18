import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UiQueryResult } from '../chat/types';
import { QueryResultCard } from './query-result-card';

const failed = (extra: Partial<UiQueryResult>): UiQueryResult => ({
  id: 'r1',
  sql: 'select c.z01_nomee from cgm c',
  columns: [],
  rowCount: 0,
  truncated: false,
  durationMs: 0,
  source: 'direct',
  purpose: null,
  error: 'x',
  ...extra,
});

describe('QueryResultCard errors', () => {
  it('shows name-check findings with "Você quis dizer…?" instead of a generic failure', () => {
    render(
      <QueryResultCard
        databaseId="db-1"
        result={failed({
          validation: true,
          error:
            'A consulta não foi executada: há nomes que não existem no banco.\n- coluna "z01_nomee" não existe em public.cgm. Você quis dizer: z01_nome, z01_nomecomple?',
        })}
      />,
    );
    expect(screen.getByText('Consulta não executada: nomes que não existem')).toBeInTheDocument();
    expect(screen.getByText(/Você quis dizer: z01_nome, z01_nomecomple\?/)).toBeInTheDocument();
    expect(screen.queryByText('A consulta falhou')).toBeNull();
  });

  it('keeps "A consulta falhou" for database errors', () => {
    render(<QueryResultCard databaseId="db-1" result={failed({ error: 'division by zero' })} />);
    expect(screen.getByText('A consulta falhou')).toBeInTheDocument();
    expect(screen.getByText('division by zero')).toBeInTheDocument();
  });
});

describe('QueryResultCard SQL actions', () => {
  it('has Copiar and, when the page allows it, Rodar next to the executed SQL', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const onRunSql = vi.fn();
    render(
      <QueryResultCard
        databaseId="db-1"
        onRunSql={onRunSql}
        result={failed({ error: null, rowCount: 1, columns: [], sql: 'select 1 from cgm' })}
      />,
    );
    // direct results open the SQL area by default
    await user.click(screen.getByRole('button', { name: 'Rodar SQL' }));
    expect(onRunSql).toHaveBeenCalledWith('select 1 from cgm');
    await user.click(screen.getByRole('button', { name: 'Copiar SQL' }));
    expect(writeText).toHaveBeenCalledWith('select 1 from cgm');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copiar SQL' })).toHaveAttribute(
        'title',
        'Copiado',
      ),
    );
  });

  it('disables Rodar with the reason, and omits it when the page gives no runner', () => {
    const { rerender } = render(
      <QueryResultCard
        databaseId="db-1"
        onRunSql={vi.fn()}
        runDisabledReason="Aguarde a resposta terminar"
        result={failed({ error: null, rowCount: 1, columns: [] })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Rodar SQL' })).toBeDisabled();
    rerender(
      <QueryResultCard
        databaseId="db-1"
        result={failed({ error: null, rowCount: 1, columns: [] })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Rodar SQL' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copiar SQL' })).toBeInTheDocument();
  });

  it('confirms before re-running a query that failed the name check', async () => {
    const user = userEvent.setup();
    const onRunSql = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <QueryResultCard
        databaseId="db-1"
        onRunSql={onRunSql}
        result={failed({ validation: true, error: 'há nomes que não existem' })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Rodar SQL' }));
    expect(confirm).toHaveBeenCalled();
    expect(onRunSql).not.toHaveBeenCalled();
  });
});
