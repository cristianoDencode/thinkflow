import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SqlBlockValidationDto } from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { Markdown } from '../chat/markdown';
import { INVALID_RUN_CONFIRM, type SqlCodeActions } from './sql-code-block';

const SQL = 'select c.z01_nome from public.cgm c limit 5';
const ANSWER = [
  'Use esta consulta:',
  '',
  '```sql',
  SQL,
  '```',
  '',
  'Uma configuração:',
  '',
  '```json',
  '{"select": 1}',
  '```',
  '',
  'E outra consulta sem rótulo:',
  '',
  '```',
  'WITH x AS (SELECT 1 AS n) SELECT n FROM x',
  '```',
].join('\n');

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function view(
  content: string,
  actions: Partial<SqlCodeActions> | null,
  opts: { streaming?: boolean } = {},
) {
  const codeActions: SqlCodeActions | undefined = actions
    ? { databaseId: 'db-1', validations: [], ...actions }
    : undefined;
  return render(
    <ThemeProvider>
      <Markdown
        content={content}
        streaming={opts.streaming ?? false}
        {...(codeActions ? { codeActions } : {})}
      />
    </ThemeProvider>,
  );
}

describe('Markdown: chat stays unchanged without codeActions', () => {
  it('renders SQL blocks as plain highlighted code, with no buttons or badges', () => {
    view(ANSWER, null);
    expect(screen.queryByRole('button', { name: 'Rodar SQL' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copiar SQL' })).toBeNull();
    expect(screen.getByText(/z01_nome/)).toBeInTheDocument();
    expect(document.querySelectorAll('pre')).toHaveLength(3);
  });
});

describe('Markdown: SQL block actions (Dados com IA)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adds Rodar and Copiar to SQL blocks only (labeled or an unlabeled query), not to other code', () => {
    view(ANSWER, { onRun: vi.fn() });
    expect(screen.getAllByRole('button', { name: 'Rodar SQL' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Copiar SQL' })).toHaveLength(2);
    // the json block is untouched
    expect(document.querySelectorAll('pre')).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Rodar SQL' })[0]).toHaveAttribute(
      'title',
      expect.stringContaining('Rodar'),
    );
  });

  it('runs the block as direct SQL', async () => {
    const onRun = vi.fn();
    const user = userEvent.setup();
    view(ANSWER, { onRun });
    await user.click(screen.getAllByRole('button', { name: 'Rodar SQL' })[0]!);
    expect(onRun).toHaveBeenCalledWith(SQL);
    await user.click(screen.getAllByRole('button', { name: 'Rodar SQL' })[1]!);
    expect(onRun).toHaveBeenLastCalledWith('WITH x AS (SELECT 1 AS n) SELECT n FROM x');
  });

  it('disables Rodar while streaming or without a connection, but still copies', async () => {
    const onRun = vi.fn();
    const user = userEvent.setup();
    const { unmount } = view(ANSWER, { onRun }, { streaming: true });
    expect(screen.getAllByRole('button', { name: 'Rodar SQL' })[0]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Copiar SQL' })[0]).toBeEnabled();
    unmount();

    view(ANSWER, { onRun, runDisabledReason: 'Selecione uma conexão' });
    const run = screen.getAllByRole('button', { name: 'Rodar SQL' })[0]!;
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', 'Selecione uma conexão');
    await user.click(run);
    expect(onRun).not.toHaveBeenCalled();
  });

  it('copies the SQL to the clipboard and flips to a check mark for a moment', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    view(ANSWER, { onRun: vi.fn() });
    const copy = screen.getAllByRole('button', { name: 'Copiar SQL' })[0]!;
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith(SQL);
    await waitFor(() => expect(copy).toHaveAttribute('title', 'Copiado'));
    await waitFor(() => expect(copy).toHaveAttribute('title', 'Copiar SQL'), { timeout: 3000 });
  });

  it('asks for confirmation before running a block whose validation found problems', async () => {
    const onRun = vi.fn();
    const user = userEvent.setup();
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const validations: SqlBlockValidationDto[] = [
      {
        index: 0,
        status: 'invalid',
        issues: [
          { message: 'coluna "z01_nomee" não existe em public.cgm.', suggestions: ['z01_nome'] },
        ],
        reason: null,
      },
    ];
    view(ANSWER, { onRun, validations });
    const run = screen.getAllByRole('button', { name: 'Rodar SQL' })[0]!;

    await user.click(run);
    expect(confirm).toHaveBeenCalledWith(INVALID_RUN_CONFIRM);
    expect(onRun).not.toHaveBeenCalled();

    await user.click(run);
    expect(onRun).toHaveBeenCalledWith(SQL);

    // the block without a verdict runs without asking
    await user.click(screen.getAllByRole('button', { name: 'Rodar SQL' })[1]!);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(onRun).toHaveBeenCalledTimes(2);
  });

  it('shows the validation badge of each state, with the issues and their suggestions', () => {
    const validations: SqlBlockValidationDto[] = [
      {
        index: 0,
        status: 'invalid',
        issues: [
          {
            message: 'coluna "z01_nomee" não existe em public.cgm.',
            suggestions: ['z01_nome', 'z01_nomecomple'],
          },
        ],
        reason: null,
      },
      { index: 1, status: 'ok', issues: [], reason: null },
    ];
    view(ANSWER, { onRun: vi.fn(), validations });
    expect(screen.getByText('Tabelas ou campos com problema')).toBeInTheDocument();
    expect(screen.getByText(/coluna "z01_nomee" não existe em public.cgm\./)).toBeInTheDocument();
    expect(screen.getByText(/Você quis dizer:/)).toBeInTheDocument();
    expect(screen.getByText('z01_nomecomple')).toBeInTheDocument();
    expect(screen.getByText('Tabelas e campos conferidos')).toBeInTheDocument();
  });

  it('shows why a block could not be checked', () => {
    view(ANSWER, {
      onRun: vi.fn(),
      validations: [
        {
          index: 0,
          status: 'unchecked',
          issues: [],
          reason: 'Conexão recusada em db.local:5432.',
        },
      ],
    });
    expect(screen.getByText('Não conferido')).toBeInTheDocument();
    expect(screen.getByText('Conexão recusada em db.local:5432.')).toBeInTheDocument();
  });

  it('checks a block without a stored verdict on demand (POST /validate)', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => json({ status: 'ok', issues: [], reason: null }));
    vi.stubGlobal('fetch', fetchMock);
    view(ANSWER, { onRun: vi.fn() });

    const buttons = screen.getAllByRole('button', { name: 'Conferir tabelas e campos' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]!);

    await waitFor(() =>
      expect(screen.getByText('Tabelas e campos conferidos')).toBeInTheDocument(),
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/databases/db-1/validate');
    expect(JSON.parse(String(init.body))).toEqual({ sql: SQL });
    expect(screen.getAllByRole('button', { name: 'Conferir tabelas e campos' })).toHaveLength(1);
  });

  it('does not offer the on-demand check while streaming or without a connection', () => {
    const { unmount } = view(ANSWER, { onRun: vi.fn() }, { streaming: true });
    expect(screen.queryByRole('button', { name: 'Conferir tabelas e campos' })).toBeNull();
    unmount();
    view(ANSWER, { onRun: vi.fn(), databaseId: null });
    expect(screen.queryByRole('button', { name: 'Conferir tabelas e campos' })).toBeNull();
    const blocks = document.querySelectorAll('pre');
    expect(within(blocks[0]!.parentElement!).getByText('SQL')).toBeInTheDocument();
  });
});
